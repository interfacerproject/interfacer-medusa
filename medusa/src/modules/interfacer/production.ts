// Live mode: Zenflows-registered keys only; standalone: fixture keyring.
import { verifyCommerceOperation } from "./zenflows-person"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireCommerceMode } from "./deployment"
import { buildReferences, buildRefuse, readBuildQuote } from "./build-purchase"
import { termsHash } from "./matching"
import { zenflowsConfig } from "./zenflows-event"
import { readInstance } from "./zenflows-registry"
import { enqueueMilestone, resumeMilestone, runZenflowsSyncSafely, withSync, type MilestoneInput } from "./zenflows-outbox"

// Explicit admin/supplier "produced" assertion, not a payment subscriber and not
// a fabricated native fulfillment/delivery. The immutable receipt IS the local
// production milestone; insert and idempotency fact are the same DB commit.
export async function produceBuild(container: MedusaContainer, orderId: string, auth?: unknown) {
  requireCommerceMode()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-build-produce:" + orderId, async () => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: [order] } = await query.graph({ entity: "order", filters: { id: orderId },
      fields: ["id", "status", "customer_id", "currency_code", "total", "metadata", "items.*", "items.detail.*",
        "payment_collections.payments.*"] })
    if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "build_order_not_found")
    if (order.status === "canceled") buildRefuse("interfacer_order_canceled")
    if (order.items?.length !== 1) buildRefuse("build_one_supplier_one_quote_required")
    const line = order.items[0]
    const [offer] = await integration.listBuildOffers({ medusa_variant_id: line.variant_id ?? "" })
    if (!offer || offer.medusa_product_id !== line.product_id) buildRefuse("build_offer_required")
    const quote = await readBuildQuote(integration, offer.quote_id)
    await verifyCommerceOperation(auth, "commerce.order.produce", { order_id: orderId }, quote.provider_person_id)
    const [identity] = await integration.listIdentityLinks({ customer_id: order.customer_id ?? "" })
    const purchase = order.metadata?.interfacer_purchase as Record<string, unknown> | undefined
    const [acceptance] = await integration.listBuildAcceptances({ id: String(purchase?.acceptance_id ?? "") })
    if (!identity || !acceptance || acceptance.customer_id !== order.customer_id ||
        acceptance.quote_id !== quote.id) buildRefuse("build_acceptance_required")
    const { data: [cart] } = await query.graph({ entity: "cart", filters: { id: acceptance.cart_id },
      fields: ["id", "order.id"] })
    if (cart?.order?.id !== orderId) buildRefuse("build_order_cart_mismatch")
    const refs = buildReferences(quote)
    if (termsHash(line.metadata?.interfacer_build) !== termsHash(refs) ||
        termsHash(purchase) !== termsHash({ buyer_person_id: identity.person_id,
          identity_link_id: identity.id, acceptance_id: acceptance.id, build: refs }))
      buildRefuse("build_order_evidence_required")
    if (Number(line.quantity) !== 1 || order.currency_code !== "eur" ||
        Number(order.total) !== quote.total_price_cents / 100 ||
        Number(line.unit_price) !== quote.total_price_cents / 100) buildRefuse("build_fixed_quote_price_required")
    // Manual upfront payment must actually have been captured, not merely
    // authorized. Native capture remains a financial action with no REA write.
    const payments = order.payment_collections?.flatMap((p: { payments?: { provider_id: string; captured_at?: string; canceled_at?: string; amount: unknown }[] }) => p.payments ?? []) ?? []
    if (payments.length !== 1 || payments[0].provider_id !== "pp_system_default" ||
        !payments[0].captured_at || payments[0].canceled_at ||
        Number(payments[0].amount) !== quote.total_price_cents / 100) buildRefuse("build_upfront_payment_required")
    const [previous] = await integration.listReaReceipts({ order_id: orderId })
    // A retry reuses the persisted milestone time, so its payload hashes identically.
    const has_point_in_time = previous ? new Date(previous.has_point_in_time) : new Date()
    // Live: the registered service owner produces and hands over; the produced
    // lot uses the instance's unitOne unless a unit is configured explicitly.
    const cfg = zenflowsConfig()
    if (cfg && identity.zenflows_person_id === quote.provider_person_id) buildRefuse("self_purchase_forbidden")
    const unit = cfg && !previous ? cfg.unit ?? (await readInstance(cfg)).unitOne : cfg?.unit
    const milestone: MilestoneInput = {
      action: "produce", quantity: quote.quantity, has_point_in_time,
      note: `interfacer-marketplace produce order=${orderId} service=${quote.service_id}`,
      // A real produced Zenflows resource, tracked to the design.
      resource_name: `Interfacer build ${quote.design_id}`,
      resource_tracking_id: quote.design_id,
      receiver: identity.zenflows_person_id ?? undefined,
      provider: cfg ? quote.provider_person_id : undefined,
      unit,
    }
    if (previous) return { created: false, ...await resumeMilestone(integration, previous, milestone) }
    // Durable outbox (see delivery.ts): Process -> produce -> transfer run after
    // the receipt and its pending sync row have committed together.
    const { receipt, sync } = await enqueueMilestone(integration, {
      action: "produce", provider_id: quote.provider_person_id, receiver_id: identity.person_id,
      resource_id: quote.design_id, design_id: quote.design_id, service_id: quote.service_id,
      dpp_id: quote.origin_dpp_id!, origin_dpp_id: quote.origin_dpp_id,
      quote_id: quote.id, quote_hash: quote.quote_hash,
      order_id: orderId, quantity: quote.quantity, has_point_in_time,
    }, milestone)
    // Re-read after commit: the in-transaction DTO lacks DB-committed fields, and
    // retries/listings must see byte-identical receipts.
    if (!sync) return { created: true, receipt: await integration.retrieveReaReceipt(receipt.id) }
    const state = await runZenflowsSyncSafely(integration, sync.id)
    return { created: true, receipt: withSync(await integration.retrieveReaReceipt(receipt.id), state) }
  })
}
