import { model } from "@medusajs/framework/utils"

// A maker's signed promise: "my registered fabrication service builds this
// registered design for a setup fee plus a per-piece price, ready in N days".
// Immutable revisions per (service, design); the latest one is current, and an
// inactive latest revision pauses it. Signed by the service's owner.
export const BuildListing = model.define("interfacer_build_listing", {
  id: model.id({ prefix: "ifbl" }).primaryKey(),
  service_resource_id: model.text(),
  design_resource_id: model.text(),
  revision: model.number(),
  entry_key: model.text().unique(),
  owner_agent_id: model.text(),
  active: model.boolean(),
  base_price_cents: model.number(),
  per_unit_price_cents: model.number(),
  lead_days: model.number(),
  terms_hash: model.text(),
  registered_by: model.text(),
  registration_hash: model.text(),
})
