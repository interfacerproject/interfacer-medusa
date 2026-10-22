import { model } from "@medusajs/framework/utils"

export const Service = model.define("interfacer_service", {
  id: model.id({ prefix: "ifsvc" }).primaryKey(),
  name: model.text(),
  provider_person_id: model.text(),
  capabilities: model.json(),
  // Integer cents at rest; API/pure terms expose EUR major units.
  base_price_cents: model.number(),
  per_unit_price_cents: model.number(),
  location: model.json(),
})
