// Money around an order, with Stripe Connect DIRECT CHARGES: who the seller
// is, their Stripe account and the commission terms they signed, the payment
// session on their account, capture at delivery, and lapsed authorizations.
//
// Invariants:
// - A Stripe order carries the settlement terms it was bought under
//   (order.metadata.interfacer_settlement, stamped at checkout, rechecked by
//   the completion hook). Later fee changes never touch an existing order.
// - Its PaymentIntent lives on exactly that seller's account, for exactly the
//   cart total, with exactly the commission of those terms as application
//   fee, manual capture: checked on Stripe before the cart is completed.
// - Stock: captured at the signed delivery. Build: captured once the order
//   exists (it can take longer than an authorization lasts).
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import {
  cancelOrderWorkflow, capturePaymentWorkflow, createPaymentCollectionForCartWorkflow, createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { readBuildQuote } from "./build-purchase"
import { addDays, paymentSettings, platformFee, STRIPE_PROVIDER_ID, SYSTEM_PROVIDER_ID, toCents,
  type FeeTerms } from "./payments"
import { connectStatus, createConnectAccount, onboardingLink, STRIPE_DASHBOARD_URL, stripeApi,
  type ConnectStatus, type StripeApi } from "./stripe-connect"
import { verifyCommerceOperation } from "./zenflows-person"
import { requireCommerceMode } from "./deployment"
import { checkoutEvidence, type CheckoutCart } from "./checkout-guard"

export function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}
const invalid = (reason: string): never => { throw new MedusaError(MedusaError.Types.INVALID_DATA, reason) }

export type Settlement = FeeTerms & { seller_person_id: string; stripe_account_id: string }

const integrationOf = (c: MedusaContainer) => c.resolve<InterfacerService>(INTERFACER_MODULE)
const queryOf = (c: MedusaContainer) => c.resolve(ContainerRegistrationKeys.QUERY)

// Stripe releases an uncaptured authorization after 7 days.
export const AUTHORIZATION_DAYS = 7

// ---- seller accounts ----

export const ONBOARD_OP = "commerce.payouts.onboard"
// Where Standard accounts can be opened for the marketplace's sellers.
export const PAYOUT_COUNTRIES = ["AT", "BE", "DE", "DK", "ES", "FI", "FR", "GR", "IE", "IT", "NL", "PL", "PT", "SE"]

function stripeSettings() {
  const s = paymentSettings()
  if (!s.stripe) refuse("payments_not_enabled")
  return { ...s, stripe: s.stripe! }
}

async function refreshAccount(integration: InterfacerService, api: StripeApi,
  row: { id: string; stripe_account_id: string }): Promise<ConnectStatus> {
  const status = connectStatus(await api.accounts.retrieve(row.stripe_account_id))
  await integration.updateSellerAccounts({ id: row.id, details_submitted: status.details_submitted,
    charges_enabled: status.charges_enabled, payouts_enabled: status.payouts_enabled,
    status_checked_at: new Date() } as any)
  return status
}

const termsMatch = (row: FeeTerms, terms: FeeTerms) => row.terms_version === terms.terms_version &&
  row.fee_bps === terms.fee_bps && row.fee_fixed_cents === terms.fee_fixed_cents

// The seller signs the commission terms in force ({country, terms_version,
// fee_bps, fee_fixed_cents}); the first call creates their Standard account,
// every call returns a fresh Stripe onboarding link until it can take payments.
export async function onboardSeller(container: MedusaContainer, body: unknown, auth: unknown) {
  requireCommerceMode()
  const s = stripeSettings()
  const params = body as Record<string, unknown> | undefined
  const person = (auth as { envelope?: { person_id?: unknown } } | undefined)?.envelope?.person_id
  if (typeof person !== "string" || !params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).sort().join(",") !== "country,fee_bps,fee_fixed_cents,terms_version" ||
      typeof params.country !== "string" || !PAYOUT_COUNTRIES.includes(params.country))
    invalid("invalid_payout_onboarding")
  if (!termsMatch(params as unknown as FeeTerms, s.terms)) refuse("seller_terms_outdated")
  await verifyCommerceOperation(auth, ONBOARD_OP, params, person as string)
  const integration = integrationOf(container)
  const api = stripeApi()
  return integration.withProjectionLock("interfacer-seller-account:" + person, async () => {
    let [row] = await integration.listSellerAccounts({ person_id: person as string })
    if (row && row.country !== params!.country) refuse("payout_country_fixed")
    if (!row) {
      // Deterministic key: a retried first call reuses the same Stripe account.
      const account = await createConnectAccount(api, person as string, params!.country as string,
        "interfacer-seller-account:" + person)
      row = await integration.createSellerAccounts({ person_id: person as string, stripe_account_id: account.id,
        country: params!.country as string, ...s.terms, terms_accepted_at: new Date() } as any) as any
    } else if (!termsMatch(row as unknown as FeeTerms, s.terms)) {
      // Re-signing accepts the new terms; orders already placed keep theirs.
      await integration.updateSellerAccounts({ id: row.id, ...s.terms, terms_accepted_at: new Date() } as any)
    }
    const status = await refreshAccount(integration, api, row)
    const url = status.ready ? null : await onboardingLink(api, row.stripe_account_id, s.stripe.gui_url)
    return { account_id: row.stripe_account_id, status, onboarding_url: url }
  })
}

// What the seller sees: whether payments are real, the terms in force and the
// ones they signed, and their account status (live from Stripe).
export async function sellerPaymentsOverview(container: MedusaContainer, person: string) {
  const s = paymentSettings()
  const base = { provider: s.provider, terms: s.terms, return_window_days: s.return_window_days,
    authorization_days: AUTHORIZATION_DAYS, countries: PAYOUT_COUNTRIES, dashboard_url: STRIPE_DASHBOARD_URL }
  if (!s.stripe) return { ...base, account: null }
  const integration = integrationOf(container)
  const [row] = await integration.listSellerAccounts({ person_id: person })
  if (!row) return { ...base, account: null }
  let status: ConnectStatus | null = null
  try { status = await refreshAccount(integration, stripeApi(), row) } catch { /* show the cached state */ }
  return { ...base, account: {
    account_id: row.stripe_account_id, country: row.country,
    signed_terms: { terms_version: row.terms_version, fee_bps: row.fee_bps, fee_fixed_cents: row.fee_fixed_cents },
    terms_current: termsMatch(row as unknown as FeeTerms, s.terms),
    status: status ?? { account_id: row.stripe_account_id, details_submitted: row.details_submitted,
      charges_enabled: row.charges_enabled, payouts_enabled: row.payouts_enabled,
      ready: row.details_submitted && row.charges_enabled, requirements_due: [], disabled_reason: null, stale: true },
  } }
}

// ---- checkout: whose account, under which terms ----

// Terms a Stripe checkout freezes on the cart. Refuses a seller who cannot be
// paid (no account, onboarding unfinished, outdated signed terms) before the
// buyer authorizes anything.
export async function checkoutSettlement(container: MedusaContainer, seller_person_id: string,
  opts: { live?: boolean } = { live: true }): Promise<Settlement | undefined> {
  const s = paymentSettings()
  if (!s.stripe) return undefined
  const integration = integrationOf(container)
  const [row] = await integration.listSellerAccounts({ person_id: seller_person_id })
  if (!row) refuse("seller_payouts_not_ready")
  if (!termsMatch(row as unknown as FeeTerms, s.terms)) refuse("seller_terms_outdated")
  const ready = opts.live ? (await refreshAccount(integration, stripeApi(), row)).ready
    : row.details_submitted && row.charges_enabled
  if (!ready) refuse("seller_payouts_not_ready")
  return { seller_person_id, stripe_account_id: row.stripe_account_id, terms_version: row.terms_version,
    fee_bps: row.fee_bps, fee_fixed_cents: row.fee_fixed_cents }
}

// The seller a checkout's money goes to, from the immutable evidence.
export function evidenceSeller(evidence: { kind: "stock" | "build"; lines: { binding?: { seller_agent_id: string } }[];
  purchase: { build?: { service_provider_person_id?: string } } }): string {
  const seller = evidence.kind === "stock" ? evidence.lines[0]?.binding?.seller_agent_id
    : evidence.purchase.build?.service_provider_person_id
  if (!seller || (evidence.kind === "stock" && evidence.lines.some(l => l.binding?.seller_agent_id !== seller)))
    refuse("one_seller_per_order_required")
  return seller!
}

type SessionRow = { id: string; provider_id: string; status?: string; data?: Record<string, any> | null }
type PaymentCart = CheckoutCart & { total?: unknown; completed_at?: string | null
  payment_collection?: { id: string; payment_sessions?: SessionRow[] } | null }

async function readPaymentCart(container: MedusaContainer, cartId: string): Promise<PaymentCart> {
  const { data: [cart] } = await queryOf(container).graph({ entity: "cart", filters: { id: cartId }, fields: [
    "id", "customer_id", "currency_code", "total", "completed_at", "metadata", "shipping_methods.id", "items.*",
    "items.adjustments.*", "items.tax_lines.*", "payment_collection.id", "payment_collection.payment_sessions.*",
  ] })
  if (!cart) throw new MedusaError(MedusaError.Types.NOT_FOUND, "cart_not_found")
  return cart as unknown as PaymentCart
}

// The Stripe terms of a direct charge for this settlement and this total.
function directTerms(settlement: Settlement, total_cents: number) {
  return { stripe_account: settlement.stripe_account_id, application_fee_amount: platformFee(total_cents, settlement) }
}

// The buyer's payment session: a PaymentIntent on the SELLER's account with the
// commission as application fee, both computed here, never by the client.
// Reuses a matching session (an authorized payment is never replaced).
export async function createMarketPaymentSession(container: MedusaContainer, cartId: string, customerId: string) {
  requireCommerceMode()
  stripeSettings()
  let cart = await readPaymentCart(container, cartId)
  if (cart.customer_id !== customerId) refuse("buyer_cart_required")
  if (cart.completed_at) refuse("cart_already_completed")
  const evidence = await checkoutEvidence(container, cart)
  if (!evidence) refuse("marketplace_cart_required")
  const settlement = (await checkoutSettlement(container, evidenceSeller(evidence as any)))!
  const total_cents = toCents(cart.total)
  if (total_cents <= 0) refuse("cart_total_required")
  const terms = directTerms(settlement, total_cents)
  return integrationOf(container).withProjectionLock("interfacer-payment-session:" + cartId, async () => {
    if (!cart.payment_collection) {
      await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cartId } })
      cart = await readPaymentCart(container, cartId)
    }
    const reusable = (cart.payment_collection!.payment_sessions ?? []).find(s => s.provider_id === STRIPE_PROVIDER_ID &&
      s.data?.stripe_account === terms.stripe_account && s.data?.application_fee_amount === terms.application_fee_amount &&
      s.data?.amount === total_cents && !["canceled", "error"].includes(String(s.status)) && s.data?.status !== "canceled")
    const session = reusable ?? (await createPaymentSessionsWorkflow(container).run({ input: {
      payment_collection_id: cart.payment_collection!.id, provider_id: STRIPE_PROVIDER_ID,
      data: { interfacer_direct: { ...terms, order_reference: cartId } },
    } })).result as unknown as SessionRow
    const secret = session.data?.client_secret
    if (typeof secret !== "string") refuse("payment_session_failed")
    return { provider_id: STRIPE_PROVIDER_ID, client_secret: secret, stripe_account: terms.stripe_account,
      amount_cents: total_cents }
  })
}

// Before the cart is completed (the checkout middleware): the PaymentIntent is
// authorized on Stripe, on this seller's account, for this total and this
// commission. Also keeps Medusa 2.10.3 off its failed-authorization path,
// which leaks reserved_quantity (interfacer-medusa#5).
export async function verifyStripePayment(container: MedusaContainer, cartId: string, settlement: Settlement | undefined) {
  if (!paymentSettings().stripe) return
  if (!settlement) refuse("order_settlement_terms_missing")
  const cart = await readPaymentCart(container, cartId)
  const sessions = (cart.payment_collection?.payment_sessions ?? []).filter(s => s.provider_id === STRIPE_PROVIDER_ID)
  if (sessions.length !== 1) refuse("payment_not_authorized")
  const total_cents = toCents(cart.total)
  const terms = directTerms(settlement!, total_cents)
  const data = sessions[0].data ?? {}
  if (data.stripe_account !== terms.stripe_account || !/^pi_[A-Za-z0-9]+$/.test(String(data.id ?? "")))
    refuse("payment_terms_mismatch")
  const intent = await stripeApi().paymentIntents.retrieve(String(data.id), {}, { stripeAccount: terms.stripe_account })
  if (intent.amount !== total_cents || intent.currency !== "eur" || intent.capture_method !== "manual" ||
      (intent.application_fee_amount ?? 0) !== terms.application_fee_amount) refuse("payment_terms_mismatch")
  if (!["requires_capture", "succeeded"].includes(intent.status)) refuse("payment_not_authorized")
}

// A marketplace cart pays only through the marketplace's provider: with real
// payments on, a test (system) session must never complete an order.
export function requireMarketPaymentSessions(cart: { payment_collection?: { payment_sessions?: { provider_id: string }[] } | null }) {
  const sessions = cart.payment_collection?.payment_sessions ?? []
  const allowed = marketProviderIds()
  if (!sessions.length || sessions.some(s => !allowed.has(s.provider_id))) refuse("payment_provider_not_allowed")
}

// The region offers exactly the marketplace's provider: Stripe when real
// payments are on (the test provider is removed), else the system provider.
export async function ensureRegionPaymentProvider(container: MedusaContainer, region_id: string) {
  const wanted = paymentSettings().provider_id
  const { data: [region] } = await queryOf(container).graph({
    entity: "region", fields: ["id", "payment_providers.id"], filters: { id: region_id },
  })
  const ids = (region?.payment_providers ?? []).map((p: { id: string }) => p.id)
  if (ids.length !== 1 || ids[0] !== wanted) {
    const { updateRegionsWorkflow } = await import("@medusajs/medusa/core-flows")
    await updateRegionsWorkflow(container).run({ input: { selector: { id: region_id },
      update: { payment_providers: [wanted] } } })
  }
  return wanted
}

// ---- orders: seller, payment ----

export type PaidOrder = {
  id: string; status: string; customer_id: string | null; currency_code: string; created_at?: string
  metadata?: Record<string, unknown> | null
  items: { id: string; variant_id: string | null; product_id: string | null; quantity: unknown; unit_price: unknown }[]
  payment_collections?: { payments?: Payment[] }[]
}
export type Payment = { id: string; provider_id: string; amount: unknown; created_at?: string
  captured_at?: string | null; canceled_at?: string | null
  data?: Record<string, unknown> | null; refunds?: { id: string; amount: unknown; note?: string | null }[] }

export async function readPaidOrder(container: MedusaContainer, orderId: string): Promise<PaidOrder> {
  const { data: [order] } = await queryOf(container).graph({
    entity: "order", filters: { id: orderId }, fields: [
      "id", "status", "customer_id", "currency_code", "created_at", "metadata", "items.id", "items.variant_id",
      "items.product_id", "items.quantity", "items.unit_price", "payment_collections.payments.*",
      "payment_collections.payments.refunds.*",
    ],
  })
  if (!order) throw new MedusaError(MedusaError.Types.NOT_FOUND, "order_not_found")
  return order as unknown as PaidOrder
}

// The one payment a marketplace order has. Anything else needs an operator.
export function orderPayment(order: PaidOrder): Payment {
  const payments = order.payment_collections?.flatMap(c => c.payments ?? []) ?? []
  if (payments.length !== 1) refuse("order_payment_reconciliation_required")
  return payments[0]
}

export const marketProviderIds = () => new Set([paymentSettings().provider_id])
export const isStripePayment = (p: Payment) => p.provider_id === STRIPE_PROVIDER_ID

// Paid for the after-sale rules: captured, or (Stripe stock before delivery)
// authorized and not released.
export function paymentHeld(p: Payment): boolean {
  return !p.canceled_at && (!!p.captured_at || isStripePayment(p))
}

export function refundedCents(payment: Payment): number {
  return (payment.refunds ?? []).reduce((sum, r) => sum + toCents(r.amount), 0)
}

// The seller of a marketplace order: the listing's seller (stock) or the
// quote's provider (build). Throws when the order is not a marketplace order.
export async function sellerOfOrder(container: MedusaContainer, order: PaidOrder): Promise<{
  seller_person_id: string; kind: "stock" | "build" }> {
  if (order.items?.length !== 1) refuse("interfacer_single_resource_order_required")
  const variant = order.items[0].variant_id ?? ""
  const integration = integrationOf(container)
  const [binding] = await integration.listListingBindings({ medusa_variant_id: variant })
  if (binding) return { seller_person_id: binding.seller_agent_id, kind: "stock" }
  const [offer] = await integration.listBuildOffers({ medusa_variant_id: variant })
  if (!offer) refuse("marketplace_order_required")
  const quote = await readBuildQuote(integration, offer.quote_id)
  return { seller_person_id: quote.provider_person_id, kind: "build" }
}

export async function buyerOfOrder(container: MedusaContainer, order: PaidOrder): Promise<string> {
  const [identity] = await integrationOf(container).listIdentityLinks({ customer_id: order.customer_id ?? "" })
  if (!identity) refuse("interfacer_bound_customer_required")
  return identity.person_id
}

// ---- capture ----

const settlementLock = <T>(container: MedusaContainer, orderId: string, work: () => Promise<T>) =>
  integrationOf(container).withProjectionLock("interfacer-settlement:" + orderId, work)

async function captureOrderPayment(container: MedusaContainer, orderId: string) {
  const order = await readPaidOrder(container, orderId)
  const payment = orderPayment(order)
  if (order.status === "canceled" || payment.canceled_at) refuse("interfacer_order_canceled")
  if (payment.captured_at) return
  try {
    await capturePaymentWorkflow(container).run({ input: { payment_id: payment.id } })
  } catch (error) {
    // Stripe released the authorization (7 days) or the buyer's bank refused.
    if (isStripePayment(payment)) refuse("payment_authorization_expired")
    throw error
  }
}

// When the buyer's capture step runs: builds are captured now (production can
// outlast an authorization); Stripe stock orders wait for the delivery.
export async function captureAtCheckout(container: MedusaContainer, orderId: string): Promise<boolean> {
  const order = await readPaidOrder(container, orderId)
  const payment = orderPayment(order)
  if (!marketProviderIds().has(payment.provider_id) || payment.canceled_at) refuse("demo_manual_payment_required")
  if (isStripePayment(payment) && (await sellerOfOrder(container, order)).kind === "stock") return false
  await settlementLock(container, orderId, () => captureOrderPayment(container, orderId))
  return true
}

// Before a delivery/production milestone. A pending cancellation request must
// be answered first (accepting it cancels the order). Stock with Stripe: the
// payment is captured here, as the seller hands the item over; anything else
// must already be captured.
export async function assertMilestoneAllowed(container: MedusaContainer, orderId: string, kind: "stock" | "build") {
  await settlementLock(container, orderId, async () => {
    const open = await integrationOf(container).listAfterSaleCases({ order_id: orderId, kind: "cancellation",
      status: ["requested"] })
    if (open.length) refuse("aftersale_cancellation_pending")
    if (!paymentSettings().stripe) return
    const payment = orderPayment(await readPaidOrder(container, orderId))
    if (!marketProviderIds().has(payment.provider_id)) refuse("captured_payment_required")
    if (kind === "stock") return captureOrderPayment(container, orderId)
    if (!payment.captured_at || payment.canceled_at) refuse("captured_payment_required")
  })
}

// ---- lapsed authorizations (job) ----

// A Stripe stock order not delivered within the authorization's lifetime: once
// Stripe has released the money, the order is canceled natively (its unit is
// for sale again) and any open request on it is closed.
export async function cancelLapsedAuthorizations(container: MedusaContainer, now = new Date()) {
  if (!paymentSettings().stripe) return 0
  const payments = container.resolve(Modules.PAYMENT)
  const stale = await payments.listPayments({ provider_id: STRIPE_PROVIDER_ID, captured_at: null, canceled_at: null } as any,
    { take: 100, order: { created_at: "ASC" } })
  let canceled = 0
  for (const p of stale as any[]) {
    if (new Date(p.created_at) > addDays(now, -(AUTHORIZATION_DAYS - 1))) continue
    const account = String(p.data?.stripe_account ?? ""), id = String(p.data?.id ?? "")
    let status: string
    try { status = (await stripeApi().paymentIntents.retrieve(id, {}, { stripeAccount: account })).status }
    catch { continue }
    if (status !== "canceled") continue
    const { data: [collection] } = await queryOf(container).graph({ entity: "payment_collection",
      filters: { id: p.payment_collection_id }, fields: ["id", "order.id"] })
    const orderId = (collection as any)?.order?.id
    if (!orderId) continue
    await settlementLock(container, orderId, async () => {
      const order = await readPaidOrder(container, orderId)
      if (order.status !== "canceled")
        await cancelOrderWorkflow(container).run({ input: { order_id: orderId, canceled_by: "interfacer-authorization-expired" } })
      const integration = integrationOf(container)
      for (const c of await integration.listAfterSaleCases({ order_id: orderId, status: ["requested", "accepted"] }))
        await integration.updateAfterSaleCases({ id: c.id, status: "withdrawn", closed_at: new Date(),
          seller_note: "Order canceled: the payment authorization expired before delivery." } as any)
    })
    canceled++
  }
  return canceled
}

export { SYSTEM_PROVIDER_ID, STRIPE_PROVIDER_ID }
