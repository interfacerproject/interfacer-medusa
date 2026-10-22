import { model } from "@medusajs/framework/utils"

// Immutable content-addressed terms. P5 must resolve this ID from this store,
// not trust client-supplied prices, supplier IDs or mutable service data.
export const BuildQuote = model.define("interfacer_build_quote", {
  id: model.id({ prefix: "ifquote" }).primaryKey(),
  design_id: model.text(),
  service_id: model.text(),
  provider_person_id: model.text(),
  origin_dpp_id: model.text().nullable(),
  currency_code: model.enum(["eur"]),
  quantity: model.number(),
  total_price_cents: model.number(),
  quote_hash: model.text().unique(),
  snapshot: model.json(),
})
