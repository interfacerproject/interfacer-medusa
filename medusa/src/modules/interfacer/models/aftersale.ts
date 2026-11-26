import { model } from "@medusajs/framework/utils"

// A buyer's after-sale request on one order, and the seller's handling of it.
// - cancellation: before the delivery/production milestone. Accepting it
//   cancels the order natively (reservation released) and refunds in full.
// - return: after the milestone, within the return window. Accepting it asks
//   the buyer to send the item back; the seller then signs that it arrived
//   (the physical-return fact) together with the refund (the financial fact).
// Every transition is signed by the person who made it; rows keep who and when.
export const AfterSaleCase = model.define("interfacer_aftersale_case", {
  id: model.id({ prefix: "ifcase" }).primaryKey(),
  order_id: model.text().index(),
  kind: model.enum(["cancellation", "return"]),
  status: model.enum(["requested", "accepted", "rejected", "withdrawn", "returned", "refunded"]).default("requested"),
  buyer_person_id: model.text(),
  seller_person_id: model.text(),
  reason: model.text(),
  seller_note: model.text().nullable(),
  responded_at: model.dateTime().nullable(),
  returned_at: model.dateTime().nullable(),
  closed_at: model.dateTime().nullable(),
})

// One financial refund to the buyer (full or partial), with the seller's share
// taken back from their payout. Never deleted; `note` on the native Medusa
// refund carries this id so an interrupted refund is reconciled, not repeated.
export const Refund = model.define("interfacer_refund", {
  id: model.id({ prefix: "ifrf" }).primaryKey(),
  order_id: model.text().index(),
  case_id: model.text().nullable(),
  amount_cents: model.number(),
  reason: model.text(),
  requested_by: model.text(),
  status: model.enum(["pending", "done", "failed"]).default("pending"),
  // How much of the seller's already-transferred share Stripe took back.
  reversal_cents: model.number().default(0),
  reversal_id: model.text().nullable(),
  last_error: model.text().nullable(),
})
