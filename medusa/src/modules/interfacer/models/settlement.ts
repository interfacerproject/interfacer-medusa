import { model } from "@medusajs/framework/utils"

// A seller's (or maker's) own Stripe account (Standard, direct charges) and the
// commission terms they signed for. One per Interfacer Person. Status fields
// are a cache of what Stripe last said; checkout re-reads Stripe first.
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
  charges_enabled: model.boolean().default(false),
  payouts_enabled: model.boolean().default(false),
  status_checked_at: model.dateTime().nullable(),
})
