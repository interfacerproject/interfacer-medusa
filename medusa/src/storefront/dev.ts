// OPT-IN LOCAL DEMO ONLY. The network signer is intentionally not production auth.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import type { ICartModuleService } from "@medusajs/framework/types"
import { allowLocalRequest } from "../api/dev/interfacer/local-guard"
import { checkoutEvidence, refuse } from "../modules/interfacer/checkout-guard"
import { checkoutOperationParams } from "../modules/interfacer/signed-envelope"
import { INTERFACER_MODULE } from "../modules/interfacer"
import type InterfacerService from "../modules/interfacer/service"
import { readBuildQuote } from "../modules/interfacer/build-purchase"

export const DEMO_FILE = resolve(__dirname, "../../../.tmp/storefront-demo.json")
export type Demo = {
  label: string; run: string; email: string; password: string; buyer_person_id: string
  customer_id: string; context: { publishable_key: string; region_id: string; sales_channel_id: string }
  products: { product_id: string; variant_id: string; listing_id: string; resource_id: string; dpp_id: string }[]
}
export function demo(): Demo { return JSON.parse(readFileSync(DEMO_FILE, "utf8")) }
export function allowStorefront(req: MedusaRequest, res: MedusaResponse): boolean {
  if (!allowLocalRequest(req, res)) return false
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress ?? "")
  // Do not trust forwarded headers. Deny DNS rebinding and cross-origin requests.
  // The loopback + host-allowlist + origin-match checks block real cross-origin
  // abuse (a cross-origin fetch carries an Origin header -> origin-match refuses).
  // We do NOT reject on sec-fetch-site: a legitimate top-level page navigation
  // opened from another page/newtab/terminal link is "cross-site" yet carries no
  // Origin, and must load — otherwise the user sees a cryptic JSON refusal.
  const origin = req.headers.origin
  if (process.env.INTERFACER_DEV_STOREFRONT !== "true" || !loopback ||
      !["localhost:9000", "127.0.0.1:9000"].includes(req.headers.host ?? "") ||
      (origin && origin !== `http://${req.headers.host}`)) {
    res.status(403).json({ reason: "local_storefront_only" })
    return false
  }
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return true
}
export function requireDemoCustomer(req: MedusaRequest, scene: Demo) {
  if ((req as AuthenticatedMedusaRequest).auth_context?.actor_id !== scene.customer_id) refuse("demo_customer_required")
}
export function strictBody(req: MedusaRequest, keys: string[]): Record<string, string> {
  const b = req.body as Record<string, unknown> | undefined
  if (!b || Array.isArray(b) || Object.keys(b).sort().join(",") !== [...keys].sort().join(",") ||
      Object.values(b).some(v => typeof v !== "string" || !v.trim() || v.length > 1000))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "invalid_demo_body")
  return b as Record<string, string>
}
export async function demoOrder(req: MedusaRequest, scene: Demo, orderId: string) {
  requireDemoCustomer(req, scene)
  const { data: [order] } = await req.scope.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order", filters: { id: orderId }, fields: ["id", "customer_id", "status", "items.*", "payment_collections.payments.*"],
  })
  if (!order || order.customer_id !== scene.customer_id || order.status === "canceled" || order.items?.length !== 1)
    refuse("demo_order_required")
  return order
}
// Resolve canonical facts on the server; callers cannot select keys, prices,
// Person IDs, purchase metadata, arbitrary operations or arbitrary private files.
export async function demoSigningOperation(req: MedusaRequest, scene: Demo) {
  requireDemoCustomer(req, scene)
  const action = (req.body as { action?: string })?.action
  if (action === "checkout" || action === "build") {
    const b = strictBody(req, action === "checkout" ? ["action", "cartId"] : ["action", "cartId", "quoteId"])
    const cart = await req.scope.resolve<ICartModuleService>(Modules.CART).retrieveCart(b.cartId, { relations: ["items"] })
    if (cart.customer_id !== scene.customer_id) refuse("demo_cart_required")
    if (action === "build") {
      const quote = await readBuildQuote(req.scope.resolve<InterfacerService>(INTERFACER_MODULE), b.quoteId)
      if (!["p4-demo-provider-standard", "p4-demo-provider-large"].includes(quote.provider_person_id)) refuse("demo_provider_required")
      return { op: "commerce.order.build.purchase", params: { cart_id: cart.id, quote_id: quote.id }, person: scene.buyer_person_id }
    }
    const evidence = await checkoutEvidence(req.scope, cart)
    if (!evidence || evidence.purchase.buyer_person_id !== scene.buyer_person_id) refuse("demo_cart_required")
    if (evidence.kind === "stock" && cart.items?.some(i => !scene.products.some(p => p.variant_id === i.variant_id))) refuse("demo_product_required")
    return { op: "commerce.order.authorize", params: checkoutOperationParams(cart, evidence.purchase), person: scene.buyer_person_id }
  }
  if (["deliver", "produce", "capture"].includes(action ?? "")) {
    const b = strictBody(req, ["action", "orderId"])
    const order = await demoOrder(req, scene, b.orderId)
    if (action === "capture") return { op: "commerce.order.dev.capture", params: { order_id: order.id }, person: scene.buyer_person_id }
    const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
    if (action === "deliver") {
      const product = scene.products.find(p => p.variant_id === order.items[0].variant_id)
      if (!product) refuse("demo_product_required")
      const binding = await integration.retrieveListingBinding(product.listing_id)
      if (binding.seller_agent_id !== "01JTESTPERSON00000000000001") refuse("demo_seller_required")
      return { op: "commerce.order.deliver", params: { order_id: order.id }, person: binding.seller_agent_id }
    }
    const [offer] = await integration.listBuildOffers({ medusa_variant_id: order.items[0].variant_id })
    if (!offer) refuse("demo_build_required")
    const quote = await readBuildQuote(integration, offer.quote_id)
    if (!["p4-demo-provider-standard", "p4-demo-provider-large"].includes(quote.provider_person_id)) refuse("demo_provider_required")
    return { op: "commerce.order.produce", params: { order_id: order.id }, person: quote.provider_person_id }
  }
  throw new MedusaError(MedusaError.Types.INVALID_DATA, "unsupported_demo_action")
}
