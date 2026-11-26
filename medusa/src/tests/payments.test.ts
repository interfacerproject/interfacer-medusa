import assert from "node:assert/strict"
import { test } from "node:test"
import {
  paymentConfigProblems, paymentSettings, platformFee, remainingNet, sellerShareOfRefunds, settlementSplit,
  STRIPE_PROVIDER_ID, SYSTEM_PROVIDER_ID,
} from "../modules/interfacer/payments"
import { caseEligibility, nextCaseStatus, type OrderFacts } from "../modules/interfacer/aftersale"
import { chargeOf, connectStatus, setStripeApiForTests, stripeOptions, type StripeApi } from "../modules/interfacer/stripe-connect"
import { advancePayout } from "../modules/interfacer/settlement"

const STRIPE = {
  STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc",
  INTERFACER_GUI_URL: "https://gui.example.org/", INTERFACER_PLATFORM_FEE_BPS: "800",
}

test("without a Stripe key the marketplace keeps the system test provider", () => {
  const s = paymentSettings({})
  assert.equal(s.provider, "system")
  assert.equal(s.provider_id, SYSTEM_PROVIDER_ID)
  assert.deepEqual(s.terms, { fee_bps: 0, fee_fixed_cents: 0, terms_version: "2026-11" })
  assert.equal(s.hold_days, 14)
  assert.deepEqual(paymentConfigProblems({}), [])
})

test("a complete Stripe configuration is accepted; the GUI URL loses its trailing slash", () => {
  const s = paymentSettings(STRIPE)
  assert.equal(s.provider_id, STRIPE_PROVIDER_ID)
  assert.equal(s.stripe?.gui_url, "https://gui.example.org")
  assert.equal(s.terms.fee_bps, 800)
  assert.deepEqual(paymentConfigProblems(STRIPE), [])
})

test("half-configured or unsafe Stripe settings refuse to start", () => {
  const problems = (env: Record<string, string>) => paymentConfigProblems({ ...STRIPE, ...env }).join("; ")
  assert.match(problems({ STRIPE_PUBLISHABLE_KEY: "" }), /STRIPE_PUBLISHABLE_KEY/)
  assert.match(problems({ STRIPE_WEBHOOK_SECRET: "nope" }), /STRIPE_WEBHOOK_SECRET/)
  assert.match(problems({ INTERFACER_GUI_URL: "" }), /INTERFACER_GUI_URL/)
  assert.match(problems({ STRIPE_PUBLISHABLE_KEY: "pk_live_abc" }), /both be test or both be live/)
  assert.match(problems({ INTERFACER_PLATFORM_FEE_BPS: "9000" }), /FEE_BPS/)
  assert.match(problems({ INTERFACER_PLATFORM_FEE_BPS: "-1" }), /FEE_BPS/)
  assert.match(problems({ INTERFACER_PAYOUT_HOLD_DAYS: "x" }), /HOLD_DAYS/)
  assert.match(problems({ STRIPE_API_BASE: "http://127.0.0.1:12111", NODE_ENV: "production" }), /STRIPE_API_BASE/)
  // A pilot promises that nothing is charged: live keys need an explicit switch.
  const live = { STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PUBLISHABLE_KEY: "pk_live_abc", INTERFACER_DEPLOYMENT: "pilot" }
  assert.match(problems(live), /INTERFACER_LIVE_PAYMENTS/)
  assert.doesNotMatch(problems({ ...live, INTERFACER_LIVE_PAYMENTS: "true" }), /INTERFACER_LIVE_PAYMENTS/)
})

test("commission: percentage plus fixed part, rounded to the cent, never above the price", () => {
  assert.equal(platformFee(1995, { fee_bps: 800, fee_fixed_cents: 0 }), 160) // 159.6 -> 160
  assert.equal(platformFee(1995, { fee_bps: 800, fee_fixed_cents: 25 }), 185)
  assert.equal(platformFee(10, { fee_bps: 0, fee_fixed_cents: 25 }), 10)
  assert.deepEqual(settlementSplit(3600, { fee_bps: 1000, fee_fixed_cents: 0 }),
    { gross_cents: 3600, fee_cents: 360, net_cents: 3240 })
  assert.throws(() => platformFee(-1, { fee_bps: 0, fee_fixed_cents: 0 }), /invalid_cents/)
  assert.throws(() => platformFee(1.5, { fee_bps: 0, fee_fixed_cents: 0 }), /invalid_cents/)
})

test("refunds take back the seller's share proportionally, without drifting", () => {
  const payout = { gross_cents: 1995, net_cents: 1835 }
  assert.equal(sellerShareOfRefunds(payout, 0), 0)
  assert.equal(sellerShareOfRefunds(payout, 1995), 1835)
  assert.equal(sellerShareOfRefunds(payout, 500), 460) // 459.9
  // Two partial refunds add up to the same share as one of their sum.
  const first = sellerShareOfRefunds(payout, 333)
  const second = sellerShareOfRefunds(payout, 333 + 1662) - first
  assert.equal(first + second, 1835)
  assert.equal(remainingNet(payout, 500), 1835 - 460)
  assert.throws(() => sellerShareOfRefunds(payout, 1996), /refund_exceeds_payment/)
})

const facts = (f: Partial<OrderFacts> = {}): OrderFacts => ({
  canceled: false, captured: true, paid_cents: 1995, refunded_cents: 0, milestone_at: null, open_case: false, ...f,
})

test("cancellation only before handover; return only after it, inside the window", () => {
  const now = new Date("2026-11-26T12:00:00Z")
  const delivered = new Date("2026-11-20T12:00:00Z")
  assert.deepEqual(caseEligibility("cancellation", facts(), 14, now), { ok: true })
  assert.deepEqual(caseEligibility("cancellation", facts({ milestone_at: delivered }), 14, now),
    { ok: false, reason: "cancellation_after_handover" })
  assert.deepEqual(caseEligibility("return", facts(), 14, now), { ok: false, reason: "return_before_handover" })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered }), 14, now), { ok: true })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered }), 5, now),
    { ok: false, reason: "return_window_closed" })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered, open_case: true }), 14, now),
    { ok: false, reason: "aftersale_case_open" })
  assert.deepEqual(caseEligibility("cancellation", facts({ captured: false }), 14, now),
    { ok: false, reason: "captured_payment_required" })
  assert.deepEqual(caseEligibility("cancellation", facts({ refunded_cents: 1995 }), 14, now),
    { ok: false, reason: "order_fully_refunded" })
  assert.deepEqual(caseEligibility("cancellation", facts({ canceled: true }), 14, now),
    { ok: false, reason: "order_canceled" })
})

test("case lifecycle: only the listed transitions exist", () => {
  assert.equal(nextCaseStatus("return", "requested", "accept"), "accepted")
  assert.equal(nextCaseStatus("return", "accepted", "returned"), "returned")
  assert.equal(nextCaseStatus("return", "returned", "refunded"), "refunded")
  assert.equal(nextCaseStatus("return", "accepted", "withdraw"), "withdrawn")
  assert.equal(nextCaseStatus("cancellation", "requested", "reject"), "rejected")
  assert.equal(nextCaseStatus("cancellation", "accepted", "refunded"), "refunded")
  assert.throws(() => nextCaseStatus("cancellation", "accepted", "withdraw"), /aftersale_transition_forbidden/)
  assert.throws(() => nextCaseStatus("cancellation", "requested", "returned"), /aftersale_transition_forbidden/)
  assert.throws(() => nextCaseStatus("return", "rejected", "accept"), /aftersale_transition_forbidden/)
  assert.throws(() => nextCaseStatus("return", "refunded", "refunded"), /aftersale_transition_forbidden/)
})

test("a connected account is ready only with details, payouts and active transfers", () => {
  const account = (extra: Record<string, unknown>) => ({ id: "acct_1", details_submitted: true, payouts_enabled: true,
    capabilities: { transfers: "active" }, requirements: { currently_due: [], past_due: [], disabled_reason: null },
    ...extra }) as any
  assert.equal(connectStatus(account({})).ready, true)
  assert.equal(connectStatus(account({ payouts_enabled: false })).ready, false)
  assert.equal(connectStatus(account({ capabilities: { transfers: "pending" } })).ready, false)
  const due = connectStatus(account({ details_submitted: false,
    requirements: { currently_due: ["external_account"], past_due: ["external_account", "tos_acceptance.date"] } }))
  assert.deepEqual(due.requirements_due, ["external_account", "tos_acceptance.date"])
})

test("tests may point the SDK at a local Stripe stand-in", () => {
  assert.deepEqual(stripeOptions("http://127.0.0.1:12111"),
    { maxNetworkRetries: 2, appInfo: { name: "interfacer-marketplace" }, host: "127.0.0.1", port: 12111, protocol: "http" })
  assert.equal(stripeOptions().host, undefined)
})

test("a transfer is tied to the order's own charge", async () => {
  const api = { paymentIntents: { retrieve: async () => ({ status: "succeeded", latest_charge: "ch_9" }) } } as any
  assert.equal(await chargeOf(api, "pi_1", "ch_1"), "ch_1")
  assert.equal(await chargeOf(api, "pi_1", null), "ch_9")
  const pending = { paymentIntents: { retrieve: async () => ({ status: "requires_capture", latest_charge: "ch_9" }) } } as any
  await assert.rejects(chargeOf(pending, "pi_1"), /stripe_charge_not_settled/)
})

// ---- payouts against a fake container and a fake Stripe ----

function world(opts: { refunds?: number[]; cases?: unknown[]; status?: string; priorTransfers?: any[]; failCreate?: Error } = {}) {
  const payout: any = { id: "ifpo_1", order_id: "order_1", seller_person_id: "S", stripe_account_id: "acct_S",
    payment_intent_id: "pi_1", charge_id: "ch_1", currency_code: "eur", gross_cents: 1995, fee_cents: 160,
    net_cents: 1835, terms_version: "2026-11", status: "held", release_at: new Date("2026-11-01T00:00:00Z"),
    transfer_id: null, transferred_cents: 0, reversed_cents: 0, attempts: 0, last_error: null }
  const calls: { create: any[]; list: number } = { create: [], list: 0 }
  const integration = {
    retrievePayout: async () => ({ ...payout }),
    withProjectionLock: async (_k: string, work: () => Promise<unknown>) => work(),
    listAfterSaleCases: async () => opts.cases ?? [],
    updatePayouts: async (patch: any) => Object.assign(payout, patch),
  }
  const order = { id: "order_1", status: opts.status ?? "completed", customer_id: "cus_1", currency_code: "eur",
    items: [{ id: "li_1", variant_id: "v", product_id: "p", quantity: 1, unit_price: 19.95 }],
    payment_collections: [{ payments: [{ id: "pay_1", provider_id: STRIPE_PROVIDER_ID, amount: 19.95,
      captured_at: "2026-10-30", data: { id: "pi_1" }, refunds: (opts.refunds ?? []).map((c, i) => ({
        id: "ref_" + i, amount: c / 100 })) }] }] }
  const container = { resolve: (key: string) => key === "query"
    ? { graph: async () => ({ data: [order] }) } : integration } as any
  const api: StripeApi = {
    transfers: {
      list: async () => { calls.list++; return { data: opts.priorTransfers ?? [] } as any },
      create: async (params: any, options: any) => {
        if (opts.failCreate) throw opts.failCreate
        calls.create.push({ params, options })
        return { id: "tr_1", amount: params.amount, destination: params.destination, reversed: false } as any
      },
      createReversal: async () => { throw new Error("unused") },
    },
    paymentIntents: { retrieve: async () => { throw new Error("unused") } },
    accounts: {} as any, accountLinks: {} as any,
  }
  setStripeApiForTests(api)
  return { payout, calls, container }
}

test("a due payout transfers the seller's net share once, tied to the charge", async () => {
  const { payout, calls, container } = world()
  assert.equal(await advancePayout(container, payout.id, new Date("2026-11-26T00:00:00Z")), "transferred")
  assert.equal(calls.create.length, 1)
  assert.deepEqual(calls.create[0].params, { amount: 1835, currency: "eur", destination: "acct_S",
    source_transaction: "ch_1", transfer_group: "order_1", description: "Interfacer marketplace order order_1",
    metadata: { interfacer_payout_id: "ifpo_1", interfacer_order_id: "order_1" } })
  assert.equal(calls.create[0].options.idempotencyKey, "interfacer-payout:ifpo_1:1835")
  assert.equal(payout.status, "transferred")
  assert.equal(payout.transferred_cents, 1835)
  // Running again does nothing.
  assert.equal(await advancePayout(container, payout.id, new Date("2026-11-26T00:00:00Z")), "skipped")
  assert.equal(calls.create.length, 1)
})

test("a payout waits for its release date and for open after-sale cases", async () => {
  const early = world()
  assert.equal(await advancePayout(early.container, "ifpo_1", new Date("2026-10-31T00:00:00Z")), "held")
  const disputed = world({ cases: [{ id: "ifcase_1" }] })
  assert.equal(await advancePayout(disputed.container, "ifpo_1", new Date("2026-11-26T00:00:00Z")), "held")
  assert.equal(early.calls.create.length + disputed.calls.create.length, 0)
})

test("refunds before the transfer shrink it; a full refund or cancellation cancels it", async () => {
  const partial = world({ refunds: [500] })
  assert.equal(await advancePayout(partial.container, "ifpo_1", new Date("2026-11-26T00:00:00Z")), "transferred")
  assert.equal(partial.calls.create[0].params.amount, 1835 - 460)
  const full = world({ refunds: [1995] })
  assert.equal(await advancePayout(full.container, "ifpo_1", new Date("2026-11-26T00:00:00Z")), "canceled")
  assert.equal(full.payout.status, "canceled")
  const canceled = world({ status: "canceled" })
  assert.equal(await advancePayout(canceled.container, "ifpo_1", new Date("2026-11-26T00:00:00Z")), "canceled")
})

test("a transfer whose response was lost is found again, not sent twice", async () => {
  const { payout, calls, container } = world({ priorTransfers: [{ id: "tr_0", amount: 1835, destination: "acct_S",
    reversed: false, metadata: { interfacer_payout_id: "ifpo_1" } }] })
  assert.equal(await advancePayout(container, payout.id, new Date("2026-11-26T00:00:00Z")), "transferred")
  assert.equal(calls.create.length, 0)
  assert.equal(payout.transfer_id, "tr_0")
})

test("a Stripe outage is retried later with backoff; duplicates block for an operator", async () => {
  const down = world({ failCreate: new Error("stripe_connection_error") })
  const now = new Date("2026-11-26T00:00:00Z")
  assert.equal(await advancePayout(down.container, "ifpo_1", now), "retry")
  assert.equal(down.payout.status, "held")
  assert.equal(down.payout.attempts, 1)
  assert.equal(down.payout.last_error, "stripe_connection_error")
  assert.ok(new Date(down.payout.next_attempt_at) > now)
  const dup = { amount: 1835, destination: "acct_S", reversed: false, metadata: { interfacer_payout_id: "ifpo_1" } }
  const twice = world({ priorTransfers: [{ id: "tr_a", ...dup }, { id: "tr_b", ...dup }] })
  assert.equal(await advancePayout(twice.container, "ifpo_1", now), "blocked")
  assert.equal(twice.payout.status, "blocked")
  setStripeApiForTests(undefined)
})
