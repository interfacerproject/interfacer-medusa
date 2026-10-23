import { model } from "@medusajs/framework/utils"

// Legacy fixture links have no remote identity. Only the verified buyer-session
// flow stamps zenflows_person_id after proving the registered key.
export const IdentityLink = model.define("interfacer_identity_link", {
  id: model.id({ prefix: "ifid" }).primaryKey(),
  customer_id: model.text().unique(),
  person_id: model.text().unique(),
  zenflows_person_id: model.text().nullable(),
})
