// Stripe Connect for sellers and makers (direct charges): each one owns a
// Standard Stripe account, opened on Stripe's own hosted onboarding (identity,
// bank account and tax details never pass through Interfacer) and managed in
// their own Stripe dashboard. The platform only creates the account, asks
// Stripe for onboarding links and reads whether it can take payments.
import Stripe from "stripe"
import { paymentSettings } from "./payments"

// The narrow slice of the Stripe SDK this module uses (also what tests fake).
export type StripeApi = {
  accounts: {
    retrieve(id: string): Promise<Stripe.Account>
  }
  // Accounts v2 (POST /v2/core/accounts). Stripe refuses v1 account creation
  // for new Connect platforms; the account it makes is read, linked and charged
  // through the v1 API like any other. (stripe-node 15 has no v2 client.)
  createAccountV2(params: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string }>
  accountLinks: { create(params: Stripe.AccountLinkCreateParams): Promise<Stripe.AccountLink> }
  paymentIntents: {
    retrieve(id: string, params?: Stripe.PaymentIntentRetrieveParams,
      options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>
  }
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
  if (cached?.key !== key) {
    const api = new Stripe(s.secret_key, stripeOptions(s.api_base)) as unknown as StripeApi
    api.createAccountV2 = (params, idempotencyKey) => createAccountV2(s.secret_key, s.api_base, params, idempotencyKey)
    cached = { key, api }
  }
  return cached.api
}

export type ConnectStatus = {
  account_id: string
  details_submitted: boolean
  charges_enabled: boolean
  payouts_enabled: boolean
  // Ready to sell: Stripe lets the account take card payments.
  ready: boolean
  requirements_due: string[]
  disabled_reason: string | null
}

export function connectStatus(account: Stripe.Account): ConnectStatus {
  const details_submitted = !!account.details_submitted
  const charges_enabled = !!account.charges_enabled
  return {
    account_id: account.id, details_submitted, charges_enabled, payouts_enabled: !!account.payouts_enabled,
    ready: details_submitted && charges_enabled,
    requirements_due: [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])]
      .filter((v, i, all) => all.indexOf(v) === i).slice(0, 20),
    disabled_reason: account.requirements?.disabled_reason ?? null,
  }
}

// A Standard account: the seller's own, full Stripe account. They are the
// merchant of record, pay Stripe's fees, handle disputes and see everything
// in their own dashboard (https://dashboard.stripe.com).
// The API version the v2 requests are made with (v2 requires one).
export const STRIPE_V2_VERSION = "2026-11-18.endive"

async function createAccountV2(secret: string, apiBase: string | undefined, params: Record<string, unknown>,
  idempotencyKey: string): Promise<{ id: string }> {
  const res = await fetch(new URL("/v2/core/accounts", apiBase ?? "https://api.stripe.com"), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json",
      "stripe-version": STRIPE_V2_VERSION, "idempotency-key": idempotencyKey },
    body: JSON.stringify(params),
  })
  const json = await res.json().catch(() => ({})) as { id?: string; error?: { message?: string } }
  if (!res.ok || typeof json.id !== "string") throw new Error("stripe_account_create_failed: " + (json.error?.message ?? res.status))
  return { id: json.id }
}

// What a Standard account is in Accounts v2: a full Stripe dashboard, Stripe
// collects the requirements, the seller pays Stripe's fees and carries losses,
// and the account takes card payments (merchant).
export function standardAccountV2(person_id: string, country: string) {
  return {
    identity: { country: country.toUpperCase() },
    dashboard: "full",
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    metadata: { interfacer_person_id: person_id },
  }
}

export async function createConnectAccount(api: StripeApi, person_id: string, country: string, idempotencyKey: string) {
  return api.createAccountV2(standardAccountV2(person_id, country), idempotencyKey)
}

export async function onboardingLink(api: StripeApi, account_id: string, gui_url: string): Promise<string> {
  const link = await api.accountLinks.create({
    account: account_id, type: "account_onboarding",
    refresh_url: `${gui_url}/market/selling?payouts=refresh`,
    return_url: `${gui_url}/market/selling?payouts=return`,
  })
  return link.url
}

export const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/"
