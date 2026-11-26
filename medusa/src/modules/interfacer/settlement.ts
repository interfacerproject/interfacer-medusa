// Money after the sale: who sold an order, what was paid, the terms frozen at
// checkout, the seller's Stripe Connect account and the payout of their share.
//
// Invariants:
// - A Stripe order always carries the settlement terms it was bought under
//   (order.metadata.interfacer_settlement, stamped at checkout, rechecked by
//   the completion hook). Later fee changes never touch an existing order.
// - A payout exists only once the sale is economically complete (the signed
//   delivery/production milestone), and is transferred only after release_at,
//   with no after-sale case open, at most once (Stripe idempotency key plus a
//   transfer_group lookup before any re-send).
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { readBuildQuote } from "./build-purchase"
import {
  addDays, paymentSettings, remainingNet, settlementSplit, STRIPE_PROVIDER_ID, SYSTEM_PROVIDER_ID, toCents,
  type FeeTerms,
} from "./payments"
import { chargeOf, connectStatus, createConnectAccount, dashboardLink, onboardingLink, stripeApi,
  type ConnectStatus, type StripeApi } from "./stripe-connect"
import { verifyCommerceOperation } from "./zenflows-person"
import { requireCommerceMode } from "./deployment"

export function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}
const invalid = (reason: string): never => { throw new MedusaError(MedusaError.Types.INVALID_DATA, reason) }

export type Settlement = FeeTerms & { seller_person_id: string; stripe_account_id: string }

const integrationOf = (c: MedusaContainer) => c.resolve<InterfacerService>(INTERFACER_MODULE)

// ---- seller accounts ----

export const ONBOARD_OP = "commerce.payouts.onboard"
export const DASHBOARD_OP = "commerce.payouts.dashboard"
// Where Stripe Express accounts can be opened for the marketplace's sellers.
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
    payouts_enabled: status.payouts_enabled, transfers_active: status.transfers_active,
    status_checked_at: new Date() } as any)
  return status
}

// The seller signs the commission terms in force ({country, terms_version,
// fee_bps, fee_fixed_cents}); the first call creates their Express account,
// every call returns a fresh Stripe onboarding link (they expire in minutes).
export async function onboardSeller(container: MedusaContainer, body: unknown, auth: unknown) {
  requireCommerceMode()
  const s = stripeSettings()
  const params = body as Record<string, unknown> | undefined
  const person = (auth as { envelope?: { person_id?: unknown } } | undefined)?.envelope?.person_id
  if (typeof person !== "string" || !params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).sort().join(",") !== "country,fee_bps,fee_fixed_cents,terms_version" ||
      typeof params.country !== "string" || !PAYOUT_COUNTRIES.includes(params.country))
    invalid("invalid_payout_onboarding")
  if (params!.terms_version !== s.terms.terms_version || params!.fee_bps !== s.terms.fee_bps ||
      params!.fee_fixed_cents !== s.terms.fee_fixed_cents) refuse("seller_terms_outdated")
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
        country: params!.country as string, terms_version: s.terms.terms_version, fee_bps: s.terms.fee_bps,
        fee_fixed_cents: s.terms.fee_fixed_cents, terms_accepted_at: new Date() } as any) as any
    } else if (row.terms_version !== s.terms.terms_version || row.fee_bps !== s.terms.fee_bps ||
               row.fee_fixed_cents !== s.terms.fee_fixed_cents) {
      // Re-signing accepts the new terms; orders already placed keep theirs.
      await integration.updateSellerAccounts({ id: row.id, terms_version: s.terms.terms_version,
        fee_bps: s.terms.fee_bps, fee_fixed_cents: s.terms.fee_fixed_cents, terms_accepted_at: new Date() } as any)
    }
    const status = await refreshAccount(integration, api, row)
    const url = status.details_submitted && status.ready ? null : await onboardingLink(api, row.stripe_account_id, s.stripe.gui_url)
    return { account_id: row.stripe_account_id, status, onboarding_url: url }
  })
}

export async function sellerDashboardLink(container: MedusaContainer, body: unknown, auth: unknown) {
  requireCommerceMode()
  stripeSettings()
  const person = (auth as { envelope?: { person_id?: unknown } } | undefined)?.envelope?.person_id
  if (typeof person !== "string" || !body || typeof body !== "object" || Object.keys(body).length)
    invalid("invalid_payout_dashboard")
  await verifyCommerceOperation(auth, DASHBOARD_OP, {}, person as string)
  const [row] = await integrationOf(container).listSellerAccounts({ person_id: person as string })
  if (!row) refuse("payout_account_required")
  return { url: await dashboardLink(stripeApi(), row.stripe_account_id) }
}

// What the seller sees: whether payments are real, the terms in force and the
// ones they signed, their account status (live from Stripe) and their payouts.
export async function sellerPayoutOverview(container: MedusaContainer, person: string) {
  const s = paymentSettings()
  const integration = integrationOf(container)
  const payouts = await integration.listPayouts({ seller_person_id: person },
    { take: 200, order: { created_at: "DESC" } })
  const base = { provider: s.provider, terms: s.terms, hold_days: s.hold_days,
    return_window_days: s.return_window_days, countries: PAYOUT_COUNTRIES, payouts: payouts.map(publicPayout) }
  if (!s.stripe) return { ...base, account: null }
  const [row] = await integration.listSellerAccounts({ person_id: person })
  if (!row) return { ...base, account: null }
  let status: ConnectStatus | null = null
  try { status = await refreshAccount(integration, stripeApi(), row) } catch { /* show the cached state */ }
  return { ...base, account: {
    account_id: row.stripe_account_id, country: row.country,
    signed_terms: { terms_version: row.terms_version, fee_bps: row.fee_bps, fee_fixed_cents: row.fee_fixed_cents },
    terms_current: row.terms_version === s.terms.terms_version && row.fee_bps === s.terms.fee_bps &&
      row.fee_fixed_cents === s.terms.fee_fixed_cents,
    status: status ?? { account_id: row.stripe_account_id, details_submitted: row.details_submitted,
      payouts_enabled: row.payouts_enabled, transfers_active: row.transfers_active,
      ready: row.details_submitted && row.payouts_enabled && row.transfers_active,
      requirements_due: [], disabled_reason: null, stale: true },
  } }
}

export function publicPayout(p: any) {
  return { id: p.id, order_id: p.order_id, status: p.status, currency_code: p.currency_code,
    gross_cents: p.gross_cents, fee_cents: p.fee_cents, net_cents: p.net_cents, release_at: p.release_at,
    transferred_cents: p.transferred_cents, reversed_cents: p.reversed_cents, transfer_id: p.transfer_id,
    last_error: p.last_error, terms_version: p.terms_version }
}

// ---- checkout: who gets paid, under which terms ----

// Terms a Stripe checkout freezes on the cart. Refuses a seller who cannot be
// paid yet (no account, onboarding unfinished, outdated signed terms): the
// buyer is never charged for an order whose seller cannot receive the money.
export async function checkoutSettlement(container: MedusaContainer, seller_person_id: string,
  opts: { live?: boolean } = { live: true }): Promise<Settlement | undefined> {
  const s = paymentSettings()
  if (!s.stripe) return undefined
  const integration = integrationOf(container)
  const [row] = await integration.listSellerAccounts({ person_id: seller_person_id })
  if (!row) refuse("seller_payouts_not_ready")
  if (row.terms_version !== s.terms.terms_version || row.fee_bps !== s.terms.fee_bps ||
      row.fee_fixed_cents !== s.terms.fee_fixed_cents) refuse("seller_terms_outdated")
  const ready = opts.live ? (await refreshAccount(integration, stripeApi(), row)).ready
    : row.details_submitted && row.payouts_enabled && row.transfers_active
  if (!ready) refuse("seller_payouts_not_ready")
  return { seller_person_id, stripe_account_id: row.stripe_account_id, terms_version: row.terms_version,
    fee_bps: row.fee_bps, fee_fixed_cents: row.fee_fixed_cents }
}

// ---- orders: seller, payment ----

export type PaidOrder = {
  id: string; status: string; customer_id: string | null; currency_code: string; metadata?: Record<string, unknown> | null
  items: { id: string; variant_id: string | null; product_id: string | null; quantity: unknown; unit_price: unknown }[]
  payment_collections?: { payments?: Payment[] }[]
}
type Payment = { id: string; provider_id: string; amount: unknown; captured_at?: string | null; canceled_at?: string | null
  data?: Record<string, unknown> | null; refunds?: { id: string; amount: unknown; note?: string | null }[] }

export async function readPaidOrder(container: MedusaContainer, orderId: string): Promise<PaidOrder> {
  const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order", filters: { id: orderId }, fields: [
      "id", "status", "customer_id", "currency_code", "metadata", "items.id", "items.variant_id",
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

// A milestone (delivery, production) needs a captured payment through the
// marketplace's provider: never ship or build an unpaid or test-paid order
// when real payments are on.
export function requireCapturedMarketPayment(order: PaidOrder) {
  const payment = orderPayment(order)
  if (!marketProviderIds().has(payment.provider_id) || !payment.captured_at || payment.canceled_at)
    refuse("captured_payment_required")
  return payment
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

function orderSettlement(order: PaidOrder): Settlement {
  const s = order.metadata?.interfacer_settlement as Settlement | undefined
  if (!s || typeof s.stripe_account_id !== "string" || !Number.isInteger(s.fee_bps) ||
      !Number.isInteger(s.fee_fixed_cents)) refuse("order_settlement_terms_missing")
  return s!
}

// ---- payouts ----

// Called right after a milestone receipt exists (and by the job, to heal a
// crash in between). Idempotent: one payout per order, amounts from the order's
// frozen terms and what is still paid after earlier refunds.
export async function ensurePayout(container: MedusaContainer, orderId: string, milestoneAt: Date) {
  const s = paymentSettings()
  const integration = integrationOf(container)
  const [existing] = await integration.listPayouts({ order_id: orderId })
  if (existing) return existing
  const order = await readPaidOrder(container, orderId)
  const payment = orderPayment(order)
  if (payment.provider_id !== STRIPE_PROVIDER_ID) return undefined // test payments: nothing to pay out
  const terms = orderSettlement(order)
  const { seller_person_id } = await sellerOfOrder(container, order)
  if (terms.seller_person_id !== seller_person_id) refuse("order_settlement_seller_mismatch")
  const split = settlementSplit(toCents(payment.amount), terms)
  const intent = String((payment.data as any)?.id ?? "")
  if (!/^pi_[A-Za-z0-9]+$/.test(intent)) refuse("stripe_payment_intent_missing")
  const now = new Date()
  return integration.createPayouts({
    order_id: orderId, seller_person_id, stripe_account_id: terms.stripe_account_id,
    payment_intent_id: intent, charge_id: typeof (payment.data as any)?.latest_charge === "string"
      ? (payment.data as any).latest_charge : null,
    currency_code: order.currency_code, ...split, terms_version: terms.terms_version,
    release_at: addDays(milestoneAt, s.hold_days), next_attempt_at: now,
  } as any)
}

const OPEN_CASE = ["requested", "accepted", "returned"]

export type PayoutRun = "transferred" | "held" | "canceled" | "retry" | "blocked" | "skipped"

// Transfer one payout if it is due. Runs under the order's settlement lock, so
// it never races a refund on the same order.
export async function advancePayout(container: MedusaContainer, payoutId: string, now = new Date()): Promise<PayoutRun> {
  const integration = integrationOf(container)
  const first = await integration.retrievePayout(payoutId)
  return integration.withProjectionLock("interfacer-settlement:" + first.order_id, async () => {
    const payout = await integration.retrievePayout(payoutId) as any
    if (payout.status !== "held") return "skipped"
    if (new Date(payout.release_at) > now) return "held"
    const open = await integration.listAfterSaleCases({ order_id: payout.order_id, status: OPEN_CASE })
    if (open.length) return "held"
    const order = await readPaidOrder(container, payout.order_id)
    const payment = orderPayment(order)
    const amount = remainingNet(payout, refundedCents(payment))
    if (order.status === "canceled" || amount <= 0) {
      await integration.updatePayouts({ id: payout.id, status: "canceled", last_error: null } as any)
      return "canceled"
    }
    const api = stripeApi()
    try {
      // Reconcile before any (re-)send: a transfer for this order may already
      // exist from an attempt whose response was lost.
      const prior = (await api.transfers.list({ transfer_group: payout.order_id, limit: 10 })).data
        .filter(t => t.metadata?.interfacer_payout_id === payout.id && !t.reversed)
      let transfer = prior[0]
      if (prior.length > 1) throw Object.assign(new Error("payout_duplicate_transfers"), { blocked: true })
      if (!transfer) {
        const charge = await chargeOf(api, payout.payment_intent_id, payout.charge_id)
        transfer = await api.transfers.create({
          amount, currency: payout.currency_code, destination: payout.stripe_account_id,
          source_transaction: charge, transfer_group: payout.order_id,
          description: `Interfacer marketplace order ${payout.order_id}`,
          metadata: { interfacer_payout_id: payout.id, interfacer_order_id: payout.order_id },
        }, { idempotencyKey: `interfacer-payout:${payout.id}:${amount}` })
      }
      if (transfer.destination !== payout.stripe_account_id && (transfer.destination as any)?.id !== payout.stripe_account_id)
        throw Object.assign(new Error("payout_transfer_destination_mismatch"), { blocked: true })
      await integration.updatePayouts({ id: payout.id, status: "transferred", transfer_id: transfer.id,
        transferred_cents: transfer.amount, attempts: payout.attempts + 1, last_error: null } as any)
      return "transferred"
    } catch (error) {
      const blocked = (error as { blocked?: boolean }).blocked
      const attempts = payout.attempts + 1
      const delay = Math.min(60_000 * 2 ** Math.min(attempts, 10), 6 * 3_600_000)
      await integration.updatePayouts({ id: payout.id, attempts, ...(blocked ? { status: "blocked" } : {}),
        next_attempt_at: new Date(now.getTime() + delay),
        last_error: String((error as Error)?.message ?? error).slice(0, 500) } as any)
      return blocked ? "blocked" : "retry"
    }
  })
}

// The scheduled job: heal missing payouts, then transfer the due ones.
export async function runDuePayouts(container: MedusaContainer, now = new Date()) {
  if (!paymentSettings().stripe) return { created: 0, transferred: 0 }
  const integration = integrationOf(container)
  let created = 0, transferred = 0
  // Recent milestones whose payout row was not written (crash between the two).
  const receipts = await integration.listReaReceipts({ created_at: { $gte: addDays(now, -2) } } as any,
    { take: 200, order: { created_at: "DESC" } })
  const have = new Set((await integration.listPayouts({ order_id: receipts.map(r => r.order_id) },
    { take: receipts.length || 1 })).map(p => p.order_id))
  for (const receipt of receipts) {
    if (have.has(receipt.order_id)) continue
    try { if (await ensurePayout(container, receipt.order_id, new Date(receipt.has_point_in_time))) created++ }
    catch { /* legacy or test-paid orders have no payout */ }
  }
  const due = await integration.listPayouts({ status: "held", release_at: { $lte: now }, next_attempt_at: { $lte: now } } as any,
    { take: 50, order: { release_at: "ASC" } })
  for (const payout of due) if (await advancePayout(container, payout.id, now) === "transferred") transferred++
  return { created, transferred }
}

export { SYSTEM_PROVIDER_ID, STRIPE_PROVIDER_ID }

// The seller a checkout's money goes to, from the immutable evidence.
export function evidenceSeller(evidence: { kind: "stock" | "build"; lines: { binding?: { seller_agent_id: string } }[];
  purchase: { build?: { service_provider_person_id?: string } } }): string {
  const seller = evidence.kind === "stock" ? evidence.lines[0]?.binding?.seller_agent_id
    : evidence.purchase.build?.service_provider_person_id
  if (!seller || (evidence.kind === "stock" && evidence.lines.some(l => l.binding?.seller_agent_id !== seller)))
    refuse("one_seller_per_order_required")
  return seller!
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
  const { data: [region] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
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

// Before a delivery/production milestone: real payments must be captured, and
// a pending cancellation request must be answered first (accepting it cancels
// the order; delivering instead would silently ignore the buyer).
export async function assertMilestoneAllowed(container: MedusaContainer, orderId: string) {
  const order = await readPaidOrder(container, orderId)
  if (paymentSettings().stripe) requireCapturedMarketPayment(order)
  const open = await integrationOf(container).listAfterSaleCases({ order_id: orderId, kind: "cancellation",
    status: ["requested"] })
  if (open.length) refuse("aftersale_cancellation_pending")
}

// After the milestone receipt exists. A failure here is healed by the job.
export async function afterMilestone(container: MedusaContainer, orderId: string, at: Date) {
  if (!paymentSettings().stripe) return
  try { await ensurePayout(container, orderId, at) }
  catch (error) { console.warn(`[interfacer] payout for ${orderId} deferred: ${(error as Error).message}`) }
}

// Medusa 2.10.3 reserves the unit before it authorizes the payment, and a
// failed authorization leaves the inventory level's reserved_quantity behind
// (no reservation row left to release it): a one-unit listing would be
// unsellable after one declined or unconfirmed card. So the cart is completed
// only once Stripe says the PaymentIntent is authorized (or already paid).
export async function requireAuthorizedStripePayment(container: MedusaContainer, cartId: string) {
  if (!paymentSettings().stripe) return
  const { data: [cart] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "cart", filters: { id: cartId }, fields: ["id", "payment_collection.payment_sessions.*"],
  })
  const sessions = (cart as any)?.payment_collection?.payment_sessions ?? []
  for (const session of sessions) {
    if (session.provider_id !== STRIPE_PROVIDER_ID) continue
    const id = String(session.data?.id ?? "")
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) refuse("payment_not_authorized")
    const intent = await stripeApi().paymentIntents.retrieve(id)
    if (!["requires_capture", "succeeded"].includes(intent.status)) refuse("payment_not_authorized")
  }
}
