// Guarded local merchant seed: exactly one unit, local collection (no carrier).
import { verifySignedOperation } from "./signed-envelope"
import type { MedusaContainer, IInventoryService } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createInventoryItemsWorkflow, createInventoryLevelsWorkflow, updateProductVariantsWorkflow,
  updateRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { requireLocalCommerce, seedCommerce } from "./commerce-context"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"

export async function setupCheckout(container: MedusaContainer, listingId: string, auth?: unknown) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const [binding] = await integration.listListingBindings({ id: listingId })
  if (!binding) throw new MedusaError(MedusaError.Types.NOT_FOUND, "listing_not_found")
  verifySignedOperation(auth, "commerce.listing.checkout.setup", { listing_id: listingId }, binding.seller_agent_id)
  const context = await seedCommerce(container)
  return integration.withProjectionLock("interfacer-checkout-setup-v1", async () => {
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: [region] } = await query.graph({
      entity: "region", fields: ["id", "payment_providers.id"], filters: { id: context.region_id },
    })
    if (!region.payment_providers?.some((p: { id: string }) => p.id === "pp_system_default")) {
      await updateRegionsWorkflow(container).run({ input: {
        selector: { id: context.region_id },
        update: { payment_providers: [...(region.payment_providers ?? []).map((p: { id: string }) => p.id), "pp_system_default"] },
      } })
    }
    const sku = "interfacer-" + binding.id
    let [item] = await inventory.listInventoryItems({ sku })
    if (!item) {
      const { result } = await createInventoryItemsWorkflow(container).run({ input: { items: [{
        sku, title: "Interfacer local collection", requires_shipping: false,
      }] } })
      item = result[0]
    }
    const [level] = await inventory.listInventoryLevels({
      inventory_item_id: item.id, location_id: context.stock_location_id,
    })
    // NEVER replenish on retry: sold/reserved stock stays sold/reserved.
    if (!level) await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: [{
      inventory_item_id: item.id, location_id: context.stock_location_id, stocked_quantity: 1,
    }] } })
    const { data: links } = await query.graph({
      entity: "product_variant_inventory_item", fields: ["variant_id", "inventory_item_id", "required_quantity"],
      filters: { variant_id: binding.medusa_variant_id },
    })
    if (links.some(l => l.inventory_item_id !== item.id || l.required_quantity !== 1)) {
      throw new Error("reconciliation_required: unexpected inventory links")
    }
    if (!links.length) await container.resolve(ContainerRegistrationKeys.LINK).create({
      [Modules.PRODUCT]: { variant_id: binding.medusa_variant_id },
      [Modules.INVENTORY]: { inventory_item_id: item.id },
      data: { required_quantity: 1 },
    })
    await updateProductVariantsWorkflow(container).run({ input: { product_variants: [{
      id: binding.medusa_variant_id, manage_inventory: true, allow_backorder: false,
    }] } })
    return { ...context, inventory_item_id: item.id, payment_provider_id: "pp_system_default" }
  })
}
