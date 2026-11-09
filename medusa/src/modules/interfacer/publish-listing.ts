// Live mode: Zenflows-registered keys only; standalone: fixture keyring.
import { verifyCommerceOperation } from "./zenflows-person"
import type { MedusaContainer, IProductModuleService } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { seedCommerce } from "./commerce-context"
import { requireCommerceMode } from "./deployment"

// Euros in major units (Medusa v2), NOT cents. Only a signed controller operation
// can set this. No Store/cart handler consumes priceEUR or a client unit_price.
export function validatePriceEUR(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
      value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
    throw new Error("invalid_price: priceEUR must be a number > 0, <= 1000000, with at most 2 decimals")
  }
}

export async function publishListing(container: MedusaContainer, listingId: string, priceEUR: unknown, auth?: unknown) {
  requireCommerceMode()
  validatePriceEUR(priceEUR)
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const [binding] = await integration.listListingBindings({ id: listingId })
  if (!binding) throw new Error("listing_not_found")
  await verifyCommerceOperation(auth, "commerce.listing.publish", { listing_id: listingId, priceEUR }, binding.seller_agent_id)
  const commerce = await seedCommerce(container)
  // Same lock as projection: retries and concurrent publishes cannot add prices.
  return integration.withProjectionLock(binding.operation_key, async () => {
    const products = container.resolve<IProductModuleService>(Modules.PRODUCT)
    const product = await products.retrieveProduct(binding.medusa_product_id, { relations: ["variants"] })
    if (!["draft", "published"].includes(product.status) || product.variants?.length !== 1 ||
        product.variants[0].id !== binding.medusa_variant_id ||
        product.metadata?.interfacer_resource_id !== binding.catalog_resource_id ||
        product.metadata?.interfacer_dpp_id !== binding.source_dpp_id) {
      throw new Error("reconciliation_required: bound commerce projection changed")
    }
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: variants } = await query.graph({
      entity: "product_variant", fields: ["id", "price_set.id", "price_set.prices.*"],
      filters: { id: binding.medusa_variant_id },
    })
    if (!variants[0]?.price_set?.id) {
      throw new Error("reconciliation_required: variant price set missing")
    }
    const prices = variants[0].price_set.prices ?? []
    // This demo owns exactly one unconditional EUR base price. Don't overwrite
    // operator-created tiered/multi-currency pricing silently.
    if (prices.length > 1 || prices.some((p: {
      currency_code: string; rules_count: number; price_list_id?: string | null
      min_quantity?: number | null; max_quantity?: number | null
    }) => p.currency_code !== "eur" || p.rules_count > 0 ||
      p.price_list_id != null || p.min_quantity != null || p.max_quantity != null)) {
      throw new Error("reconciliation_required: unexpected price configuration")
    }
    const previous = prices[0]
    const { data: channelLinks } = await query.graph({
      entity: "product_sales_channel", fields: ["sales_channel_id"],
      filters: { product_id: product.id },
    })
    const hasChannel = channelLinks.some((l: { sales_channel_id: string }) =>
      l.sales_channel_id === commerce.sales_channel_id)
    const changed = product.status !== "published" || !hasChannel || Number(previous?.amount) !== priceEUR
    if (changed) {
      // Preserve an existing price ID: repeated publication neither replaces
      // prices nor leaves a growing set of soft-deleted price rows.
      await updateProductsWorkflow(container).run({ input: { products: [{
        id: product.id, status: ProductStatus.PUBLISHED,
        sales_channels: [...channelLinks.map((l: { sales_channel_id: string }) =>
          ({ id: l.sales_channel_id })), ...(!hasChannel ? [{ id: commerce.sales_channel_id }] : [])],
        variants: [{ id: binding.medusa_variant_id, prices: [{
          ...(previous ? { id: previous.id } : {}), currency_code: "eur", amount: priceEUR,
        }] }],
      }] } })
    }
    return {
      changed, listing_id: binding.id, product_id: product.id, variant_id: binding.medusa_variant_id,
      status: "published", price: { currency_code: "eur", amount: priceEUR },
      dpp_id: binding.source_dpp_id, ...commerce,
    }
  })
}
