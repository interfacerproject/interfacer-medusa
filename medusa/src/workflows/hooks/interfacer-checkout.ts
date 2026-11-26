import { verifyCommerceOperation } from "../../modules/interfacer/zenflows-person"
import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutEvidence, refuse } from "../../modules/interfacer/checkout-guard"
import { canonicalJson } from "../../modules/interfacer/project-resource"

import { checkoutOperationParams } from "../../modules/interfacer/signed-envelope"
import { checkoutSettlement, evidenceSeller, requireMarketPaymentSessions } from "../../modules/interfacer/settlement"

// Always on, including when fixture mode is disabled, and for internal workflow
// callers. Throwing/infrastructure failure stops completion before order/payment.
completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  const evidence = await checkoutEvidence(container, cart)
  if (!evidence) return
  if (evidence.kind === "build" && Number(cart.total) !== evidence.total) refuse("build_fixed_quote_price_required")
  if (canonicalJson(cart.metadata?.interfacer_purchase) !== canonicalJson(evidence.purchase)) {
    refuse("interfacer_checkout_evidence_required")
  }
  // Stored by the checkout middleware, which consumed its nonce on arrival.
  await verifyCommerceOperation(cart.metadata?.interfacer_authorization, "commerce.order.authorize",
    checkoutOperationParams(cart, evidence.purchase), evidence.purchase.buyer_person_id, { stored: true })
  // Only the marketplace's provider; with Stripe, the terms frozen at checkout
  // must still be the seller's signed ones and the seller still payable.
  requireMarketPaymentSessions(cart as any)
  const settlement = await checkoutSettlement(container, evidenceSeller(evidence as any), { live: false })
  if (canonicalJson(cart.metadata?.interfacer_settlement ?? null) !== canonicalJson(settlement ?? null))
    refuse("interfacer_settlement_terms_changed")
  for (const { item, metadata } of evidence.lines) {
    if (evidence.kind === "stock" && (!item.variant?.manage_inventory || item.variant.allow_backorder ||
        (item.variant.inventory_items?.length !== 1 ||
         Number(item.variant.inventory_items[0].required_quantity) !== 1))) refuse("interfacer_inventory_required")
    if (Object.entries(metadata).some(([key, value]) => canonicalJson(item.metadata?.[key]) !== canonicalJson(value))) {
      refuse("interfacer_checkout_evidence_required")
    }
  }
})
