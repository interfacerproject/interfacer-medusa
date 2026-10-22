import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { checkoutEvidence, refuse } from "../../modules/interfacer/checkout-guard"
import { canonicalJson } from "../../modules/interfacer/project-resource"

// Always on, including when fixture mode is disabled, and for internal workflow
// callers. Throwing/infrastructure failure stops completion before order/payment.
completeCartWorkflow.hooks.validate(async ({ cart }, { container }) => {
  const evidence = await checkoutEvidence(container, cart)
  if (!evidence) return
  if (evidence.kind === "build" && Number(cart.total) !== evidence.total) refuse("build_fixed_quote_price_required")
  if (canonicalJson(cart.metadata?.interfacer_purchase) !== canonicalJson(evidence.purchase)) {
    refuse("interfacer_checkout_evidence_required")
  }
  for (const { item, metadata } of evidence.lines) {
    if (evidence.kind === "stock" && (!item.variant?.manage_inventory || item.variant.allow_backorder ||
        (item.variant.inventory_items?.length !== 1 ||
         Number(item.variant.inventory_items[0].required_quantity) !== 1))) refuse("interfacer_inventory_required")
    if (Object.entries(metadata).some(([key, value]) => canonicalJson(item.metadata?.[key]) !== canonicalJson(value))) {
      refuse("interfacer_checkout_evidence_required")
    }
  }
})
