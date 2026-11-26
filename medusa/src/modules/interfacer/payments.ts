// Real payments (Stripe Connect) and the platform commission: configuration and
// the pure money arithmetic. Everything here is in integer EUR cents.
//
// Model (owner brief, 2026-11-26): the platform is the merchant of record and
// takes a commission; every seller/maker has their OWN Stripe account (Express,
// Stripe-hosted onboarding). The buyer pays the platform; the seller's share is
// transferred to their account once the sale is economically complete (the
// signed delivery / production milestone) and the hold period has passed
// ("separate charges and transfers"). Refunds before that are simple refunds;
// refunds after it also reverse the seller's share proportionally.
//
// Without STRIPE_SECRET_KEY the marketplace keeps Medusa's system (test)
// provider, exactly as in the pilot: no money moves and no payouts exist.

export const SYSTEM_PROVIDER_ID = "pp_system_default"
// Medusa provider ids are pp_<identifier>_<id>; ours registers as stripe/stripe.
export const STRIPE_PROVIDER_ID = "pp_stripe_stripe"

export type FeeTerms = { fee_bps: number; fee_fixed_cents: number; terms_version: string }
export type PaymentSettings = {
  provider: "system" | "stripe"
  provider_id: string
  terms: FeeTerms
  hold_days: number
  return_window_days: number
  stripe?: { secret_key: string; publishable_key: string; webhook_secret: string; api_base?: string; gui_url: string }
}

type Env = NodeJS.ProcessEnv

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback
  return /^\d+$/.test(value) ? Number(value) : NaN
}

export function paymentSettings(env: Env = process.env): PaymentSettings {
  const terms: FeeTerms = {
    fee_bps: int(env.INTERFACER_PLATFORM_FEE_BPS, 0),
    fee_fixed_cents: int(env.INTERFACER_PLATFORM_FEE_FIXED_CENTS, 0),
    terms_version: env.INTERFACER_SELLER_TERMS_VERSION || "2026-11",
  }
  const base = {
    terms,
    hold_days: int(env.INTERFACER_PAYOUT_HOLD_DAYS, 14),
    return_window_days: int(env.INTERFACER_RETURN_WINDOW_DAYS, 14),
  }
  if (!env.STRIPE_SECRET_KEY) return { provider: "system", provider_id: SYSTEM_PROVIDER_ID, ...base }
  return { provider: "stripe", provider_id: STRIPE_PROVIDER_ID, ...base, stripe: {
    secret_key: env.STRIPE_SECRET_KEY,
    publishable_key: env.STRIPE_PUBLISHABLE_KEY ?? "",
    webhook_secret: env.STRIPE_WEBHOOK_SECRET ?? "",
    gui_url: (env.INTERFACER_GUI_URL ?? "").replace(/\/+$/, ""),
    // Tests only: a local Stripe stand-in. Refused in production (below).
    ...(env.STRIPE_API_BASE ? { api_base: env.STRIPE_API_BASE } : {}),
  } }
}

export function stripeEnabled(env: Env = process.env): boolean {
  return !!env.STRIPE_SECRET_KEY
}

// What a payments configuration is missing or must not carry. Empty when fine.
export function paymentConfigProblems(env: Env = process.env): string[] {
  const s = paymentSettings(env)
  const problems: string[] = []
  const { fee_bps, fee_fixed_cents, terms_version } = s.terms
  if (!Number.isInteger(fee_bps) || fee_bps > 5000) problems.push("INTERFACER_PLATFORM_FEE_BPS (0-5000)")
  if (!Number.isInteger(fee_fixed_cents) || fee_fixed_cents > 10_000)
    problems.push("INTERFACER_PLATFORM_FEE_FIXED_CENTS (0-10000)")
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(terms_version)) problems.push("INTERFACER_SELLER_TERMS_VERSION")
  if (!Number.isInteger(s.hold_days) || s.hold_days > 90) problems.push("INTERFACER_PAYOUT_HOLD_DAYS (0-90)")
  if (!Number.isInteger(s.return_window_days) || s.return_window_days > 90)
    problems.push("INTERFACER_RETURN_WINDOW_DAYS (0-90)")
  if (!s.stripe) return problems
  const key = s.stripe.secret_key
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) problems.push("STRIPE_SECRET_KEY (sk_test_/sk_live_ or a restricted key)")
  const live = /^(sk|rk)_live_/.test(key)
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(s.stripe.publishable_key)) problems.push("STRIPE_PUBLISHABLE_KEY")
  else if (s.stripe.publishable_key.startsWith("pk_live_") !== live)
    problems.push("STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY must both be test or both be live")
  if (!/^whsec_[A-Za-z0-9]+$/.test(s.stripe.webhook_secret)) problems.push("STRIPE_WEBHOOK_SECRET")
  if (!/^https?:\/\/[^\s/]+/.test(s.stripe.gui_url)) problems.push("INTERFACER_GUI_URL (where Stripe sends sellers back)")
  if (s.stripe.api_base && env.NODE_ENV === "production") problems.push("STRIPE_API_BASE must be unset in production")
  // The pilot promises "nothing is charged": real money needs an explicit switch.
  if (live && env.INTERFACER_DEPLOYMENT === "pilot" && env.INTERFACER_LIVE_PAYMENTS !== "true")
    problems.push("a live Stripe key in a pilot needs INTERFACER_LIVE_PAYMENTS=true")
  return problems
}

export function assertPaymentConfig(env: Env = process.env) {
  const problems = paymentConfigProblems(env)
  if (problems.length) throw new Error("payment_config_invalid: " + problems.join("; "))
}

// ---- money arithmetic (pure) ----

export const toCents = (amount: unknown): number => Math.round(Number(amount) * 100)

function assertCents(n: number, name: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid_cents:${name}`)
}

// The platform's commission on one paid order, capped at the amount paid.
export function platformFee(gross_cents: number, terms: Pick<FeeTerms, "fee_bps" | "fee_fixed_cents">): number {
  assertCents(gross_cents, "gross")
  const fee = Math.round(gross_cents * terms.fee_bps / 10_000) + terms.fee_fixed_cents
  return Math.min(gross_cents, fee)
}

export function settlementSplit(gross_cents: number, terms: Pick<FeeTerms, "fee_bps" | "fee_fixed_cents">) {
  const fee_cents = platformFee(gross_cents, terms)
  return { gross_cents, fee_cents, net_cents: gross_cents - fee_cents }
}

// The seller's share of a refund: the same proportion of it as their share of
// the sale (the platform gives back its commission on the refunded part too).
// Cumulative, so rounding never drifts: the seller's share of everything
// refunded so far, minus what was already taken back.
export function sellerShareOfRefunds(payout: { gross_cents: number; net_cents: number },
  refunded_total_cents: number): number {
  assertCents(refunded_total_cents, "refunded_total")
  if (refunded_total_cents > payout.gross_cents) throw new Error("refund_exceeds_payment")
  if (refunded_total_cents === payout.gross_cents) return payout.net_cents
  if (!payout.gross_cents) return 0
  return Math.round(payout.net_cents * refunded_total_cents / payout.gross_cents)
}

// What the seller is still owed after the refunds so far (before any transfer).
export function remainingNet(payout: { gross_cents: number; net_cents: number }, refunded_total_cents: number) {
  return payout.net_cents - sellerShareOfRefunds(payout, refunded_total_cents)
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000)
}
