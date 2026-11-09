import { model } from "@medusajs/framework/utils"

// LIVE catalog: one immutable revision per (kind, Zenflows resource). The owner
// is the resource's accountable Person at registration, who signed it. The
// document is versioned and strictly validated (catalog.ts), never inferred.
export const CatalogEntry = model.define("interfacer_catalog_entry", {
  id: model.id({ prefix: "ifcat" }).primaryKey(),
  kind: model.enum(["design", "service"]),
  zenflows_resource_id: model.text(),
  revision: model.number(),
  entry_key: model.text().unique(),
  owner_agent_id: model.text(),
  resource_name: model.text(),
  spec_id: model.text(),
  schema_version: model.text(),
  document: model.json(),
  document_hash: model.text(),
  registered_by: model.text(),
  registration_hash: model.text(),
})
