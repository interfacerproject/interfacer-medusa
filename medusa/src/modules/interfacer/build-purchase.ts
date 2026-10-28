import { verifyCommerceOperation } from "./zenflows-person"
import type { ICartModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules, ProductStatus } from "@medusajs/framework/utils"
import { addToCartWorkflow, createProductsWorkflow, updateRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireLocalCommerce, seedCommerce } from "./commerce-context"
import { formBuildQuote, termsHash } from "./matching"

export function buildRefuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}
export async function readBuildQuote(integration: InterfacerService, id: string) {
  const [quote] = await integration.listBuildQuotes({ id })
  if (!quote) throw new MedusaError(MedusaError.Types.NOT_FOUND, "build_quote_not_found")
  const snapshot = quote.snapshot as unknown as {
    design: Parameters<typeof formBuildQuote>[0]; service: Parameters<typeof formBuildQuote>[1]
  }
  const expected = formBuildQuote(snapshot.design, snapshot.service)
  if (Object.entries(expected).some(([k, v]) =>
    termsHash(quote[k as keyof typeof quote]) !== termsHash(v))) buildRefuse("build_quote_integrity_failure")
  // P5 requires an origin reference; P4 can still match designs without one.
  if (!quote.origin_dpp_id) buildRefuse("build_origin_dpp_required")
  return quote
}
export function buildReferences(quote: Awaited<ReturnType<typeof readBuildQuote>>) {
  return { design_id: quote.design_id, service_id: quote.service_id,
    service_provider_person_id: quote.provider_person_id, quote_id: quote.id,
    quote_hash: quote.quote_hash, origin_dpp_id: quote.origin_dpp_id,
    quantity: quote.quantity }
}

// Reusable product per immutable quote; one cart unit = the complete quoted lot.
// No finite-stock allocation: this is a made-to-order promise, not stock on hand.
async function offerFor(container: MedusaContainer, quoteId: string) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const quote = await readBuildQuote(integration, quoteId)
  const context = await seedCommerce(container)
  return integration.withProjectionLock("interfacer-build-offer:" + quoteId, async () => {
    const [previous] = await integration.listBuildOffers({ quote_id: quoteId })
    if (previous) return { offer: previous, quote, context }
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const handle = "interfacer-build-" + quote.quote_hash
    let { data: products } = await query.graph({
      entity: "product", fields: ["id", "metadata", "variants.id"], filters: { handle },
    })
    if (!products.length) {
      const { result } = await createProductsWorkflow(container).run({ input: { products: [{
        title: "Build: " + (quote.snapshot as unknown as { design: { name: string } }).design.name, handle,
        status: ProductStatus.PUBLISHED, discountable: false,
        sales_channels: [{ id: context.sales_channel_id }],
        metadata: { interfacer_build_quote_id: quote.id },
        options: [{ title: "Build", values: ["Quoted lot"] }],
        variants: [{ title: "Quoted lot", options: { Build: "Quoted lot" },
          manage_inventory: false, allow_backorder: false,
          prices: [{ currency_code: "eur", amount: quote.total_price_cents / 100 }] }],
      }] } })
      products = result as typeof products
    }
    const product = products[0]
    if (products.length !== 1 || product.variants?.length !== 1 ||
        product.metadata?.interfacer_build_quote_id !== quote.id) buildRefuse("build_offer_reconciliation_required")
    const offer = await integration.createBuildOffers({ quote_id: quote.id,
      medusa_product_id: product.id, medusa_variant_id: product.variants[0].id })
    return { offer, quote, context }
  })
}

export async function acceptBuild(container: MedusaContainer, cartId: string, quoteId: string, customerId: string, auth?: unknown) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-build-accept:" + cartId, async () => {
    const carts = container.resolve<ICartModuleService>(Modules.CART)
    const cart = await carts.retrieveCart(cartId, { relations: ["items"] })
    if (cart.customer_id !== customerId) buildRefuse("interfacer_cart_customer_mismatch")
    const [identity] = await integration.listIdentityLinks({ customer_id: customerId })
    if (!identity) buildRefuse("interfacer_bound_customer_required")
    await verifyCommerceOperation(auth, "commerce.order.build.purchase", { cart_id: cartId, quote_id: quoteId }, identity.person_id)
    const [previous] = await integration.listBuildAcceptances({ cart_id: cartId })
    if (previous && (previous.quote_id !== quoteId || previous.customer_id !== customerId))
      buildRefuse("build_quote_swap_forbidden")
    if (cart.completed_at) buildRefuse("build_cart_already_completed")
    if (!previous && cart.items?.length) buildRefuse("build_empty_cart_required")
    const { offer, quote, context } = await offerFor(container, quoteId)
    if (quote.provider_person_id === identity.person_id) buildRefuse("self_purchase_forbidden")
    if (cart.currency_code !== "eur" || cart.region_id !== context.region_id ||
        cart.sales_channel_id !== context.sales_channel_id) buildRefuse("build_commerce_context_required")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: [region] } = await query.graph({
      entity: "region", fields: ["id", "payment_providers.id"], filters: { id: context.region_id },
    })
    if (!region.payment_providers?.some((p: { id: string }) => p.id === "pp_system_default")) {
      await updateRegionsWorkflow(container).run({ input: { selector: { id: context.region_id },
        update: { payment_providers: [...region.payment_providers.map((p: { id: string }) => p.id), "pp_system_default"] } } })
    }
    const acceptance = previous ?? await integration.createBuildAcceptances({
      cart_id: cartId, customer_id: customerId, quote_id: quoteId,
    })
    // Persist acceptance before adding: retry recovers a failed add without a
    // second line or changing terms. Other edits are refused at completion.
    if (!cart.items?.length) await addToCartWorkflow(container).run({ input: {
      cart_id: cartId, items: [{ variant_id: offer.medusa_variant_id, quantity: 1 }],
    } })
    return { acceptance, offer, build: buildReferences(quote), price_eur: quote.total_price_cents / 100 }
  })
}
