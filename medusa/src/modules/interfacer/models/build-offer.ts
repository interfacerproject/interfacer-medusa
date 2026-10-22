import { model } from "@medusajs/framework/utils"

// One immutable native sellable per quote. Made-to-order, not stock inventory.
export const BuildOffer = model.define("interfacer_build_offer", {
  id: model.id({ prefix: "ifoffer" }).primaryKey(),
  quote_id: model.text().unique(),
  medusa_product_id: model.text().unique(),
  medusa_variant_id: model.text().unique(),
})
// Acceptance fixes the chosen quote before checkout, independently of editable
// cart/line metadata. A service/variant swap must not silently accept new terms.
export const BuildAcceptance = model.define("interfacer_build_acceptance", {
  id: model.id({ prefix: "ifaccept" }).primaryKey(),
  cart_id: model.text().unique(),
  customer_id: model.text(),
  quote_id: model.text(),
})
