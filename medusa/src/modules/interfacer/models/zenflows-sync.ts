import { model } from "@medusajs/framework/utils"

// Durable outbox row for one live milestone (zenflows-sync.ts). Inserted in the
// SAME transaction as its receipt, before any remote write. `marker` is written
// into every remote note so ambiguous steps are reconciled, not replayed.
export const ZenflowsSync = model.define("interfacer_zenflows_sync", {
  id: model.id({ prefix: "ifzs" }).primaryKey(),
  order_id: model.text().unique(),
  receipt_id: model.text().unique(),
  marker: model.text().unique(),
  payload: model.json(),
  payload_hash: model.text(),
  status: model.enum(["pending", "done", "blocked"]).default("pending"),
  process_id: model.text().nullable(),
  resource_id: model.text().nullable(),
  creation_event_id: model.text().nullable(),
  transfer_event_id: model.text().nullable(),
  inflight_step: model.enum(["process", "create", "transfer"]).nullable(),
  inflight_at: model.dateTime().nullable(),
  attempts: model.number().default(0),
  next_attempt_at: model.dateTime(),
  last_error: model.text().nullable(),
})
