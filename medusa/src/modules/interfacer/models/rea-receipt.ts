import { model } from "@medusajs/framework/utils"

// LOCAL STAND-IN for a live Zenflows economic-event write; NOT a remote ledger.
// Swappable sink: delivery.ts resolves the facts, then calls this module's store.
export const ReaReceipt = model.define("interfacer_rea_receipt", {
  id: model.id({ prefix: "ifrea" }).primaryKey(),
  action: model.enum(["transfer", "produce"]),
  design_id: model.text().nullable(),
  service_id: model.text().nullable(),
  origin_dpp_id: model.text().nullable(),
  quote_id: model.text().nullable(),
  quote_hash: model.text().nullable(),
  provider_id: model.text(),
  receiver_id: model.text(),
  resource_id: model.text(),
  dpp_id: model.text(),
  order_id: model.text().unique(),
  quantity: model.number(),
  has_point_in_time: model.dateTime(),
  // Bridge C (pre-outbox receipts only): id of the LIVE Zenflows handover event
  // written before the receipt. Outbox receipts keep null here (rows are
  // immutable); their event id lives on interfacer_zenflows_sync.
  zenflows_event_id: model.text().nullable(),
})
