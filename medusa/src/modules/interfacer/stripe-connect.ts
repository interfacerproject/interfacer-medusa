// Stripe Connect for sellers and makers: each one owns an Express connected
// account, onboarded on Stripe's own hosted pages (identity, bank account,
// tax details never pass through Interfacer). The platform only creates the
// account, asks Stripe for onboarding/dashboard links, reads its status and
// transfers the seller's share of completed sales.
import Stripe from "stripe"
import { paymentSettings } from "./payments"

// The narrow slice of the Stripe SDK this module uses (also what tests fake).
export type StripeApi = {
  accounts: {
    create(params: Stripe.AccountCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Account>
    retrieve(id: string): Promise<Stripe.Account>
    createLoginLink(id: string): Promise<Stripe.LoginLink>
  }
  accountLinks: { create(params: Stripe.AccountLinkCreateParams): Promise<Stripe.AccountLink> }
  transfers: {
    create(params: Stripe.TransferCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Transfer>
    list(params: Stripe.TransferListParams): Promise<Stripe.ApiList<Stripe.Transfer>>
    createReversal(id: string, params: Stripe.TransferReversalCreateParams,
      options?: Stripe.RequestOptions): Promise<Stripe.TransferReversal>
  }
  paymentIntents: { retrieve(id: string): Promise<Stripe.PaymentIntent> }
}

let override: StripeApi | undefined
let cached: { key: string; api: StripeApi } | undefined

// Tests swap the client; production builds one from the configured key.
export function setStripeApiForTests(api: StripeApi | undefined) { override = api }

export function stripeOptions(apiBase?: string): Stripe.StripeConfig {
  const options: Stripe.StripeConfig = { maxNetworkRetries: 2, appInfo: { name: "interfacer-marketplace" } }
  if (!apiBase) return options
  const url = new URL(apiBase)
  return { ...options, host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    protocol: url.protocol.replace(":", "") as "http" | "https" }
}

export function stripeApi(): StripeApi {
  if (override) return override
  const s = paymentSettings().stripe
  if (!s) throw new Error("stripe_not_configured")
  const key = s.secret_key + "|" + (s.api_base ?? "")
  if (cached?.key !== key) cached = { key, api: new Stripe(s.secret_key, stripeOptions(s.api_base)) as unknown as StripeApi }
  return cached.api
}

export type ConnectStatus = {
  account_id: string
  details_submitted: boolean
  payouts_enabled: boolean
  transfers_active: boolean
  // Ready to be paid: Stripe accepts transfers to it and can pay them out.
  ready: boolean
  requirements_due: string[]
  disabled_reason: string | null
}

export function connectStatus(account: Stripe.Account): ConnectStatus {
  const transfers_active = account.capabilities?.transfers === "active"
  const details_submitted = !!account.details_submitted
  const payouts_enabled = !!account.payouts_enabled
  return {
    account_id: account.id, details_submitted, payouts_enabled, transfers_active,
    ready: details_submitted && payouts_enabled && transfers_active,
    requirements_due: [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])]
      .filter((v, i, all) => all.indexOf(v) === i).slice(0, 20),
    disabled_reason: account.requirements?.disabled_reason ?? null,
  }
}

// An Express account the platform controls: Stripe-hosted onboarding and
// dashboard, the platform pays Stripe's fees and is liable for negative
// balances (it is the merchant of record), the seller only receives transfers.
export async function createConnectAccount(api: StripeApi, person_id: string, country: string, idempotencyKey: string) {
  return api.accounts.create({
    country: country.toUpperCase(),
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      stripe_dashboard: { type: "express" },
    },
    capabilities: { transfers: { requested: true } },
    metadata: { interfacer_person_id: person_id },
  }, { idempotencyKey })
}

export async function onboardingLink(api: StripeApi, account_id: string, gui_url: string): Promise<string> {
  const link = await api.accountLinks.create({
    account: account_id, type: "account_onboarding",
    refresh_url: `${gui_url}/market/selling?payouts=refresh`,
    return_url: `${gui_url}/market/selling?payouts=return`,
  })
  return link.url
}

// The seller's own Stripe Express dashboard (bank account, payouts, tax forms).
export async function dashboardLink(api: StripeApi, account_id: string): Promise<string> {
  return (await api.accounts.createLoginLink(account_id)).url
}

// The charge a captured PaymentIntent produced: transfers are tied to it
// (source_transaction), so they never wait on, or draw from, other funds.
export async function chargeOf(api: StripeApi, payment_intent_id: string, stored?: unknown): Promise<string> {
  if (typeof stored === "string" && /^(ch|py)_[A-Za-z0-9]+$/.test(stored)) return stored
  const intent = await api.paymentIntents.retrieve(payment_intent_id)
  const charge = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id
  if (intent.status !== "succeeded" || !charge) throw new Error("stripe_charge_not_settled")
  return charge
}
