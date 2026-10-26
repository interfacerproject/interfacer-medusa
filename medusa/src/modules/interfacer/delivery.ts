import { verifySignedOperation } from "./signed-envelope"
import type { IFulfillmentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createOrderFulfillmentWorkflow, markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/medusa/core-flows"
import { requireLocalCommerce, seedCommerce } from "./commerce-context"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { enqueueMilestone, resumeMilestone, runZenflowsSyncSafely, withSync, type MilestoneInput } from "./zenflows-outbox"

function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}

type DeliveryOrder = {
  id: string; status: string; customer_id: string | null
  items: { id: string; product_id: string | null; variant_id: string | null; quantity: number;
    requires_shipping: boolean; detail?: { delivered_quantity: number } }[]
  fulfillments?: { id: string; canceled_at: string | null; delivered_at: string | null;
    items: { line_item_id: string; quantity: number }[] }[]
}

async function readOrder(container: MedusaContainer, id: string): Promise<DeliveryOrder> {
  const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order", filters: { id }, fields: [
      "id", "status", "customer_id", "items.*", "items.detail.*",
      "fulfillments.id", "fulfillments.delivered_at", "fulfillments.canceled_at",
      "fulfillments.items.line_item_id", "fulfillments.items.quantity",
    ],
  })
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "order_not_found")
  return order as DeliveryOrder
}

async function receiptFacts(container: MedusaContainer, order: Awaited<ReturnType<typeof readOrder>>) {
  // One receipt per order has a singular resource/provider. Do not silently pick
  // the first line of a mixed/multi-resource order. Broader orders need a new model.
  if (order.status === "canceled") refuse("interfacer_order_canceled")
  if (order.items?.length !== 1) refuse("interfacer_single_resource_order_required")
  const line = order.items[0]
  if (Number(line.quantity) !== 1) refuse("interfacer_single_unit_required")
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const [binding] = await integration.listListingBindings({ medusa_variant_id: line.variant_id ?? "" })
  if (!binding || binding.medusa_product_id !== line.product_id) refuse("interfacer_binding_missing")
  if (!order.customer_id) refuse("interfacer_bound_customer_required")
  const [identity] = await integration.listIdentityLinks({ customer_id: order.customer_id })
  if (!identity) refuse("interfacer_bound_customer_required")
  return { line, binding, identity }
}

// Named manual pickup option is only an internal input to the fulfillment
// workflow. No shipping charge/method is added to the already-paid P2 order.
async function localCollectionOption(container: MedusaContainer) {
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-local-collection-option-v1", async () => {
    const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT)
    const name = "Interfacer local collection P3"
    let [option] = await fulfillment.listShippingOptions({ name })
    if (!option) {
      let [profile] = await fulfillment.listShippingProfiles({ name })
      if (!profile) profile = await fulfillment.createShippingProfiles({ name, type: "default" })
      let [set] = await fulfillment.listFulfillmentSets({ name })
      if (!set) set = await fulfillment.createFulfillmentSets({ name, type: "pickup" })
      let [zone] = await fulfillment.listServiceZones({ fulfillment_set: { id: set.id } })
      if (!zone) zone = await fulfillment.createServiceZones({ name, fulfillment_set_id: set.id })
      option = await fulfillment.createShippingOptions({
        name, price_type: "flat", service_zone_id: zone.id, shipping_profile_id: profile.id,
        provider_id: "manual_manual", type: { label: "Local collection", description: "Local demo pickup", code: "interfacer-pickup" },
        data: { id: "manual-fulfillment" },
      })
    }
    if (option.provider_id !== "manual_manual") refuse("interfacer_collection_option_changed")
    return option
  })
}

// Guarded dev trigger, deliberately NOT a payment/order.placed subscriber.
// Retrying after delivery committed but before the receipt write resumes from
// persisted delivered_at; it does not deliver twice. Locks span workflow commits.
export async function deliverOrder(container: MedusaContainer, orderId: string, auth?: unknown) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-delivery-v1:" + orderId, async () => {
    let order = await readOrder(container, orderId)
    const { line, binding, identity } = await receiptFacts(container, order)
    verifySignedOperation(auth, "commerce.order.deliver", { order_id: orderId }, binding.seller_agent_id)
    if (line.requires_shipping) refuse("interfacer_local_collection_only")
    let active = (order.fulfillments ?? []).filter(f => !f.canceled_at)
    if (active.length > 1) refuse("interfacer_fulfillment_reconciliation_required")
    if (!active.length) {
      const context = await seedCommerce(container)
      const option = await localCollectionOption(container)
      await createOrderFulfillmentWorkflow(container).run({ input: {
        order_id: orderId, location_id: context.stock_location_id, shipping_option_id: option.id,
        items: [{ id: line.id, quantity: 1 }], no_notification: true,
      } })
      order = await readOrder(container, orderId)
      active = (order.fulfillments ?? []).filter(f => !f.canceled_at)
    }
    const fulfillment = active[0]
    if (!fulfillment || fulfillment.items?.length !== 1 ||
        fulfillment.items[0].line_item_id !== line.id || Number(fulfillment.items[0].quantity) !== 1) {
      refuse("interfacer_fulfillment_reconciliation_required")
    }
    // Pickup has no carrier shipment; 2.10.3 supports delivery directly after packing.
    if (!fulfillment.delivered_at) {
      await markOrderFulfillmentAsDeliveredWorkflow(container).run({ input: {
        orderId, fulfillmentId: fulfillment.id,
      } })
    }
    order = await readOrder(container, orderId)
    const delivered = order.fulfillments?.find(f => f.id === fulfillment.id && !f.canceled_at && f.delivered_at)
    if (!delivered || Number(order.items?.[0].detail?.delivered_quantity) !== 1) {
      refuse("interfacer_delivery_required")
    }
    const [previous] = await integration.listReaReceipts({ order_id: orderId })
    const has_point_in_time = new Date(delivered.delivered_at!)
    const milestone: MilestoneInput = {
      action: "transfer", quantity: Number(line.quantity), has_point_in_time,
      note: `interfacer-marketplace transfer order=${orderId}`,
      // A real per-listing Zenflows resource, tracked to the catalog resource.
      resource_name: `Interfacer listing ${binding.catalog_resource_id}`,
      resource_tracking_id: binding.catalog_resource_id,
      receiver: identity.zenflows_person_id ?? undefined,
    }
    if (previous) return { created: false, ...await resumeMilestone(integration, previous, milestone) }
    // Durable outbox: receipt + pending Zenflows sync commit first, then the
    // live write runs (inline here, else the scheduled job). A failed or lost
    // remote step stays pending and is reconciled, never blindly replayed.
    const { receipt, sync } = await enqueueMilestone(integration, {
      action: "transfer", provider_id: binding.seller_agent_id, receiver_id: identity.person_id,
      resource_id: binding.catalog_resource_id, dpp_id: binding.source_dpp_id,
      order_id: orderId, quantity: Number(line.quantity), has_point_in_time,
    }, milestone)
    // Re-read after commit: the in-transaction DTO lacks DB-committed fields, and
    // retries/listings must see byte-identical receipts.
    if (!sync) return { created: true, receipt: await integration.retrieveReaReceipt(receipt.id) }
    const state = await runZenflowsSyncSafely(integration, sync.id)
    return { created: true, receipt: withSync(await integration.retrieveReaReceipt(receipt.id), state) }
  })
}
