import type { BigNumberValue, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"

import { buildCheckoutEvidence } from "./build-checkout"

export type CheckoutItem = {
  id: string; product_id?: string | null; variant_id?: string | null; quantity: BigNumberValue
  metadata?: Record<string, unknown> | null
  unit_price?: BigNumberValue; adjustments?: { amount: BigNumberValue }[]; tax_lines?: { rate: BigNumberValue }[]
  variant?: { manage_inventory?: boolean; allow_backorder?: boolean; inventory_items?: { required_quantity?: BigNumberValue }[] }
}
export type CheckoutCart = {
  currency_code?: string; shipping_methods?: unknown[]
  id: string; customer_id?: string | null; customer?: { id: string } | null
  metadata?: Record<string, unknown> | null; items?: CheckoutItem[]
}
export function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}

// Look up immutable bindings, never infer identity/authority from client metadata.
export async function checkoutEvidence(container: MedusaContainer, cart: CheckoutCart) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const build = await buildCheckoutEvidence(container, cart)
  if (build) return build
  const productIds = [...new Set((cart.items ?? []).map(i => i.product_id).filter(Boolean))] as string[]
  const bindings = productIds.length
    ? await integration.listListingBindings({ medusa_product_id: productIds }) : []
  // Also detect damaged/missing mapping for a resource-backed projection.
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = productIds.length ? await query.graph({
    entity: "product", fields: ["id", "handle", "metadata"], filters: { id: productIds },
  }) : { data: [] }
  for (const product of products) {
    if ((product.handle?.startsWith("interfacer-") || product.metadata?.interfacer_resource_id) &&
        !bindings.some(b => b.medusa_product_id === product.id)) refuse("interfacer_binding_missing")
  }
  if (!bindings.length) return undefined
  const customerId = cart.customer?.id ?? cart.customer_id
  if (!customerId) refuse("interfacer_bound_customer_required")
  const [identity] = await integration.listIdentityLinks({ customer_id: customerId })
  if (!identity) refuse("interfacer_bound_customer_required")
  const lines = (cart.items ?? []).flatMap(item => {
    const binding = bindings.find(b => b.medusa_product_id === item.product_id)
    if (!binding) return []
    if (item.variant_id !== binding.medusa_variant_id || Number(item.quantity) !== 1) {
      refuse("interfacer_single_unit_required")
    }
    return [{ item, binding, metadata: {
      interfacer_resource_id: binding.catalog_resource_id,
      interfacer_dpp_id: binding.source_dpp_id,
      interfacer_listing_id: binding.id,
    } }]
  })
  if (new Set(lines.map(l => l.binding.id)).size !== lines.length) refuse("interfacer_single_unit_required")
  return { kind: "stock" as const, customerId, lines, purchase: {
    buyer_person_id: identity.person_id,
    identity_link_id: identity.id,
    listings: lines.map(l => l.metadata),
  } }
}
