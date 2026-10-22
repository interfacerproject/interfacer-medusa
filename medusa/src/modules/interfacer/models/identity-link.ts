import { model } from "@medusajs/framework/utils"

// Local resolver evidence, NOT proof of a Zenflows key or Person ownership.
export const IdentityLink = model.define("interfacer_identity_link", {
  id: model.id({ prefix: "ifid" }).primaryKey(),
  customer_id: model.text().unique(),
  person_id: model.text().unique(),
})
