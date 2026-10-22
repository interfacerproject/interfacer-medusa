import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { CheckoutCart } from "./checkout-guard"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { buildRefuse, buildReferences, readBuildQuote } from "./build-purchase"
import { termsHash } from "./matching"

export async function buildCheckoutEvidence(container: MedusaContainer, cart: CheckoutCart) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const [acceptance] = await integration.listBuildAcceptances({ cart_id: cart.id })
  const ids = (cart.items ?? []).map(i => i.product_id).filter(Boolean) as string[]
  const offers = ids.length ? await integration.listBuildOffers({ medusa_product_id: ids }) : []
  // Detect missing mappings too: removing a binding must not turn a build into
  // an ordinary unguarded product. Metadata is a warning flag, not authority.
  const { data: products } = ids.length ? await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "product", fields: ["id", "handle", "metadata"], filters: { id: ids },
  }) : { data: [] }
  const marked = products.some(p => p.handle?.startsWith("interfacer-build-") || p.metadata?.interfacer_build_quote_id)
  if (!acceptance && !offers.length && !marked) return undefined
  if (!acceptance) buildRefuse("build_quote_acceptance_required")
  const customerId = cart.customer?.id ?? cart.customer_id
  if (!customerId || customerId !== acceptance.customer_id) buildRefuse("interfacer_cart_customer_mismatch")
  const [identity] = await integration.listIdentityLinks({ customer_id: customerId })
  if (!identity) buildRefuse("interfacer_bound_customer_required")
  // Stronger than merely comparing supplier IDs: one complete quoted lot only,
  // never stock + build, multiple quotes or a second supplier.
  if (cart.items?.length !== 1 || offers.length !== 1) buildRefuse("build_one_supplier_one_quote_required")
  const item = cart.items[0], offer = offers[0]
  if (offer.quote_id !== acceptance.quote_id || offer.medusa_variant_id !== item.variant_id ||
      offer.medusa_product_id !== item.product_id) buildRefuse("build_quote_swap_forbidden")
  if (Number(item.quantity) !== 1) buildRefuse("build_one_quoted_lot_required")
  const quote = await readBuildQuote(integration, acceptance.quote_id)
  if (cart.currency_code !== "eur" || Number(item.unit_price) !== quote.total_price_cents / 100 ||
      item.adjustments?.some(a => Number(a.amount) !== 0) ||
      item.tax_lines?.some(t => Number(t.rate) !== 0) || cart.shipping_methods?.length)
    buildRefuse("build_fixed_quote_price_required")
  const metadata = { interfacer_build: buildReferences(quote) }
  // Refuse post-quote service/reference edits, rather than silently substituting
  // a different supplier. Missing canonical metadata is stamped by middleware.
  if (item.metadata?.interfacer_build &&
      termsHash(item.metadata.interfacer_build) !== termsHash(metadata.interfacer_build))
    buildRefuse("build_quote_swap_forbidden")
  return { kind: "build" as const, total: quote.total_price_cents / 100, customerId, lines: [{ item, metadata }],
    purchase: { buyer_person_id: identity.person_id, identity_link_id: identity.id,
      acceptance_id: acceptance.id, build: metadata.interfacer_build } }
}
