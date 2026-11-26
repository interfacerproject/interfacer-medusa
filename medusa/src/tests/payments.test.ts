import assert from "node:assert/strict"
import { test } from "node:test"
import {
  paymentConfigProblems, paymentSettings, platformFee, STRIPE_PROVIDER_ID, SYSTEM_PROVIDER_ID,
} from "../modules/interfacer/payments"
import { caseEligibility, nextCaseStatus, type OrderFacts } from "../modules/interfacer/aftersale"
import { connectStatus, setStripeApiForTests, stripeOptions } from "../modules/interfacer/stripe-connect"
import { verifyStripePayment } from "../modules/interfacer/settlement"
import DirectProvider, { sessionStatus, toMinor } from "../modules/stripe-payment/service"
import { BigNumber } from "@medusajs/framework/utils"

const STRIPE = {
  STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc",
  INTERFACER_GUI_URL: "https://gui.example.org/", INTERFACER_PLATFORM_FEE_BPS: "800",
}

test("without a Stripe key the marketplace keeps the system test provider", () => {
  const s = paymentSettings({})
  assert.equal(s.provider, "system")
  assert.equal(s.provider_id, SYSTEM_PROVIDER_ID)
  assert.deepEqual(s.terms, { fee_bps: 0, fee_fixed_cents: 0, terms_version: "2026-11" })
  assert.equal(s.return_window_days, 14)
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
  assert.match(problems({ INTERFACER_RETURN_WINDOW_DAYS: "x" }), /RETURN_WINDOW_DAYS/)
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
  assert.equal(platformFee(1900, { fee_bps: 800, fee_fixed_cents: 0 }), 152)
  assert.throws(() => platformFee(-1, { fee_bps: 0, fee_fixed_cents: 0 }), /invalid_cents/)
  assert.throws(() => platformFee(1.5, { fee_bps: 0, fee_fixed_cents: 0 }), /invalid_cents/)
})

const facts = (f: Partial<OrderFacts> = {}): OrderFacts => ({
  canceled: false, paid: true, captured: true, paid_cents: 1995, refunded_cents: 0, milestone_at: null,
  open_case: false, ...f,
})

test("cancellation only before handover; return only after it, inside the window", () => {
  const now = new Date("2026-11-26T12:00:00Z")
  const delivered = new Date("2026-11-20T12:00:00Z")
  assert.deepEqual(caseEligibility("cancellation", facts(), 14, now), { ok: true })
  // Stripe stock before delivery: only authorized, and that is enough to ask.
  assert.deepEqual(caseEligibility("cancellation", facts({ captured: false }), 14, now), { ok: true })
  assert.deepEqual(caseEligibility("cancellation", facts({ paid: false, captured: false }), 14, now),
    { ok: false, reason: "captured_payment_required" })
  assert.deepEqual(caseEligibility("cancellation", facts({ milestone_at: delivered }), 14, now),
    { ok: false, reason: "cancellation_after_handover" })
  assert.deepEqual(caseEligibility("return", facts(), 14, now), { ok: false, reason: "return_before_handover" })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered }), 14, now), { ok: true })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered }), 5, now),
    { ok: false, reason: "return_window_closed" })
  assert.deepEqual(caseEligibility("return", facts({ milestone_at: delivered, open_case: true }), 14, now),
    { ok: false, reason: "aftersale_case_open" })
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

test("a seller's account is ready to sell once Stripe lets it take card payments", () => {
  const account = (extra: Record<string, unknown>) => ({ id: "acct_1", details_submitted: true, charges_enabled: true,
    payouts_enabled: false, requirements: { currently_due: [], past_due: [], disabled_reason: null }, ...extra }) as any
  assert.equal(connectStatus(account({})).ready, true) // payouts may still be set up later
  assert.equal(connectStatus(account({ charges_enabled: false })).ready, false)
  assert.equal(connectStatus(account({ details_submitted: false })).ready, false)
  const due = connectStatus(account({ details_submitted: false,
    requirements: { currently_due: ["external_account"], past_due: ["external_account", "tos_acceptance.date"] } }))
  assert.deepEqual(due.requirements_due, ["external_account", "tos_acceptance.date"])
})

test("tests may point the SDK at a local Stripe stand-in", () => {
  assert.deepEqual(stripeOptions("http://127.0.0.1:12111"),
    { maxNetworkRetries: 2, appInfo: { name: "interfacer-marketplace" }, host: "127.0.0.1", port: 12111, protocol: "http" })
  assert.equal(stripeOptions().host, undefined)
})

// ---- the direct-charge provider against a fake Stripe ----

function provider() {
  const calls: { op: string; args: any[] }[] = []
  const intent = (extra: Record<string, unknown> = {}) => ({ id: "pi_1", object: "payment_intent", amount: 1995,
    currency: "eur", status: "requires_payment_method", application_fee_amount: 160, capture_method: "manual",
    client_secret: "pi_1_secret_x", last_payment_error: null, ...extra })
  const fake = {
    paymentIntents: {
      create: async (...args: any[]) => { calls.push({ op: "create", args }); return intent() },
      retrieve: async (...args: any[]) => { calls.push({ op: "retrieve", args }); return intent({ status: "requires_capture" }) },
      capture: async (...args: any[]) => { calls.push({ op: "capture", args }); return intent({ status: "succeeded" }) },
      cancel: async (...args: any[]) => { calls.push({ op: "cancel", args }); return intent({ status: "canceled" }) },
    },
    refunds: { create: async (...args: any[]) => { calls.push({ op: "refund", args }); return { id: "re_1" } } },
  }
  const p = new DirectProvider({}, { apiKey: "sk_test_x", webhookSecret: "whsec_x" }) as any
  p.stripe_ = fake
  return { p, calls }
}

const DIRECT = { stripe_account: "acct_S", application_fee_amount: 160, order_reference: "cart_1" }

test("direct charge: the intent lives on the seller's account, with the commission as application fee", async () => {
  const { p, calls } = provider()
  const out = await p.initiatePayment({ amount: 19.95, currency_code: "eur", context: {},
    data: { session_id: "payses_1", interfacer_direct: DIRECT } })
  const [params, options] = calls[0].args
  assert.deepEqual(params, { amount: 1995, currency: "eur", application_fee_amount: 160, capture_method: "manual",
    automatic_payment_methods: { enabled: true }, description: "Interfacer marketplace order",
    metadata: { session_id: "payses_1", interfacer_order_reference: "cart_1" } })
  assert.equal(options.stripeAccount, "acct_S")
  assert.equal(out.data.stripe_account, "acct_S")
  assert.equal(out.data.client_secret, "pi_1_secret_x")
})

test("direct charge: a session without the marketplace's terms, or with a fee above the price, is refused", async () => {
  const { p, calls } = provider()
  await assert.rejects(p.initiatePayment({ amount: 19.95, currency_code: "eur", data: { session_id: "s" } }),
    /stripe_direct_session_route_required/)
  await assert.rejects(p.initiatePayment({ amount: 1, currency_code: "eur",
    data: { session_id: "s", interfacer_direct: DIRECT } }), /fee_exceeds_amount/)
  await assert.rejects(p.initiatePayment({ amount: 19.95, currency_code: "usd",
    data: { session_id: "s", interfacer_direct: DIRECT } }), /eur_only/)
  assert.equal(calls.length, 0)
})

test("direct charge: capture, cancel and refund act on the seller's account; refunds give the commission back", async () => {
  const { p, calls } = provider()
  const data = { id: "pi_1", stripe_account: "acct_S", currency: "eur" }
  assert.equal((await p.capturePayment({ data, context: {} })).data.status, "succeeded")
  await p.cancelPayment({ data, context: {} })
  await p.refundPayment({ amount: 5, data, context: {} })
  assert.deepEqual(calls.map(c => [c.op, c.args.at(-1).stripeAccount]),
    [["capture", "acct_S"], ["cancel", "acct_S"], ["refund", "acct_S"]])
  assert.deepEqual(calls[2].args[0], { payment_intent: "pi_1", amount: 500, refund_application_fee: true })
  await assert.rejects(p.capturePayment({ data: { id: "pi_1" }, context: {} }), /stripe_direct_payment_data_missing/)
})

test("direct charge: Stripe statuses map to Medusa's session statuses", () => {
  assert.equal(sessionStatus({ status: "requires_capture", last_payment_error: null } as any), "authorized")
  assert.equal(sessionStatus({ status: "succeeded", last_payment_error: null } as any), "captured")
  assert.equal(sessionStatus({ status: "requires_action", last_payment_error: null } as any), "requires_more")
  assert.equal(sessionStatus({ status: "requires_payment_method", last_payment_error: { code: "x" } } as any), "error")
  assert.equal(sessionStatus({ status: "canceled", last_payment_error: null } as any), "canceled")
})

// ---- the check before the cart is completed ----

const SETTLEMENT = { seller_person_id: "S", stripe_account_id: "acct_S", terms_version: "2026-11", fee_bps: 800,
  fee_fixed_cents: 0 }

async function verify(intent: Record<string, unknown>, session: Record<string, unknown> = {}) {
  const cart = { id: "cart_1", total: 19.95, payment_collection: { id: "pc_1", payment_sessions: [{ id: "ps",
    provider_id: STRIPE_PROVIDER_ID, data: { id: "pi_1", stripe_account: "acct_S", ...session } }] } }
  const container = { resolve: () => ({ graph: async () => ({ data: [cart] }) }) } as any
  const asked: unknown[][] = []
  setStripeApiForTests({ paymentIntents: { retrieve: async (...args: unknown[]) => { asked.push(args); return {
    id: "pi_1", amount: 1995, currency: "eur", capture_method: "manual", application_fee_amount: 160,
    status: "requires_capture", ...intent } as any } }, accounts: {} as any, accountLinks: {} as any })
  const saved = process.env.STRIPE_SECRET_KEY
  process.env.STRIPE_SECRET_KEY = "sk_test_x"
  try { await verifyStripePayment(container, "cart_1", SETTLEMENT) }
  finally {
    setStripeApiForTests(undefined)
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = saved
  }
  return asked
}

test("completion needs an authorized intent on the seller's account, for the total and the commission", async () => {
  const asked = await verify({})
  assert.deepEqual(asked[0][2], { stripeAccount: "acct_S" })
  await assert.rejects(verify({ status: "requires_payment_method" }), /payment_not_authorized/)
  await assert.rejects(verify({ application_fee_amount: 0 }), /payment_terms_mismatch/)
  await assert.rejects(verify({ amount: 1 }), /payment_terms_mismatch/)
  await assert.rejects(verify({ capture_method: "automatic" }), /payment_terms_mismatch/)
  await assert.rejects(verify({}, { stripe_account: "acct_OTHER" }), /payment_terms_mismatch/)
})

test("direct charge: amounts arrive as numbers, strings or BigNumbers and become cents", () => {
  assert.equal(toMinor(19.95, "eur"), 1995)
  assert.equal(toMinor("19.95", "EUR"), 1995)
  assert.equal(toMinor(new BigNumber(19.95), "eur"), 1995)
  assert.equal(toMinor({ value: "5", precision: 20 }, "eur"), 500)
  assert.throws(() => toMinor("x", "eur"), /invalid_amount/)
})
