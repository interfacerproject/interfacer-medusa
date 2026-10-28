import { model } from "@medusajs/framework/utils"

// Only this module owns these references. Product metadata is not authoritative.
export const ListingBinding = model.define("interfacer_listing_binding", {
  id: model.id({ prefix: "iflb" }).primaryKey(),
  operation_key: model.text().unique(),
  catalog_resource_id: model.text().unique(),
  source_dpp_id: model.text(),
  seller_agent_id: model.text(),
  medusa_product_id: model.text().unique(),
  medusa_variant_id: model.text().unique(),
  configuration_key: model.text(),
  source_snapshot_hash: model.text(),
  passport_snapshot_hash: model.text(),
  approved_revision: model.text(),
  policy_version: model.text(),
  permission_epoch: model.text(),
  status: model.enum(["draft"]).default("draft"),
  // LIVE listings only: the unit of the seller's Zenflows resource (transfers
  // must use it). Null for fixture listings.
  zenflows_unit_id: model.text().nullable(),
})

export const ProjectionIntent = model.define("interfacer_projection_intent", {
  id: model.id({ prefix: "ifpi" }).primaryKey(),
  operation_key: model.text().unique(),
  catalog_resource_id: model.text().unique(),
  source_dpp_id: model.text(),
  seller_agent_id: model.text(),
  source_snapshot_hash: model.text(),
  passport_snapshot_hash: model.text(),
  product_handle: model.text().unique(),
})
