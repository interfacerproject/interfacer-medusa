import { model } from "@medusajs/framework/utils"

// JSON has a strict runtime schema in matching.ts; not free-form tags.
export const Design = model.define("interfacer_design", {
  id: model.id({ prefix: "ifdes" }).primaryKey(),
  name: model.text(),
  origin_dpp_id: model.text().nullable(),
  requirements: model.json(),
})
