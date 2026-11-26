import { model } from "@medusajs/framework/utils"

// A seller's (or maker's) Stripe Connect account and the commission terms they
// signed for. One per Interfacer Person. Status fields are a cache of what
// Stripe last said; checkout re-reads Stripe before accepting an order.
export const SellerAccount = model.define("interfacer_seller_account", {
  id: model.id({ prefix: "ifsa" }).primaryKey(),
  person_id: model.text().unique(),
  stripe_account_id: model.text().unique(),
  country: model.text(),
  // The terms the seller signed (commerce.payouts.onboard): what checkout freezes.
  terms_version: model.text(),
  fee_bps: model.number(),
  fee_fixed_cents: model.number(),
  terms_accepted_at: model.dateTime(),
  details_submitted: model.boolean().default(false),
  payouts_enabled: model.boolean().default(false),
  transfers_active: model.boolean().default(false),
  status_checked_at: model.dateTime().nullable(),
})

// The seller's share of one paid order. Created when the sale is economically
// complete (the signed delivery/production milestone); transferred to the
// seller's Stripe account once release_at has passed and no after-sale case is
// open. Amounts are frozen from the order's settlement terms.
export const Payout = model.define("interfacer_payout", {
  id: model.id({ prefix: "ifpo" }).primaryKey(),
  order_id: model.text().unique(),
  seller_person_id: model.text(),
  stripe_account_id: model.text(),
  payment_intent_id: model.text(),
  charge_id: model.text().nullable(),
  currency_code: model.text(),
  gross_cents: model.number(),
  fee_cents: model.number(),
  net_cents: model.number(),
  terms_version: model.text(),
  status: model.enum(["held", "transferred", "canceled", "blocked"]).default("held"),
  release_at: model.dateTime(),
  transfer_id: model.text().nullable(),
  transferred_cents: model.number().default(0),
  reversed_cents: model.number().default(0),
  attempts: model.number().default(0),
  next_attempt_at: model.dateTime(),
  last_error: model.text().nullable(),
})
