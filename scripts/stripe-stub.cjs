#!/usr/bin/env node
// LOCAL TEST STAND-IN for api.stripe.com: the slice of Stripe's HTTP API the
// marketplace uses with Connect DIRECT CHARGES (Standard accounts, account
// links, PaymentIntents and refunds made on a connected account through the
// Stripe-Account header, application fees and their proportional refund),
// with Stripe's own request encoding, idempotency keys and the money rules
// that matter here. Never a substitute for a run against Stripe's test mode.
// Test-only helpers live under /__test/. Usage: node scripts/stripe-stub.cjs [port]
const http = require("node:http")
const crypto = require("node:crypto")

const port = Number(process.argv[2] || process.env.STRIPE_STUB_PORT || 12111)
const db = { customers: {}, payment_intents: {}, charges: {}, refunds: {}, accounts: {}, application_fees: {}, idem: {} }
const id = prefix => prefix + "_" + crypto.randomBytes(9).toString("hex")
const now = () => Math.floor(Date.now() / 1000)

// a[b][c]=1 -> { a: { b: { c: "1" } } }
function parseForm(body) {
  const out = {}
  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, "").split("[")
    let node = out
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = value
      else node = node[p] = node[p] ?? {}
    })
  }
  return out
}

class StripeError extends Error {
  constructor(status, type, message, code) { super(message); Object.assign(this, { status, type, code }) }
}
const fail = (message, code, status = 400) => { throw new StripeError(status, "invalid_request_error", message, code) }
const need = (table, key) => db[table][key] ?? fail(`No such ${table.replace(/s$/, "")}: '${key}'`, "resource_missing", 404)
const int = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail("Invalid positive integer"); return n }

// Direct charges: a PaymentIntent exists only on the account it was made on.
function connected(account) {
  if (!account) fail("This stub only takes PaymentIntents on a connected account (Stripe-Account header)")
  return need("accounts", account)
}
function intentOn(pid, account) {
  const pi = db.payment_intents[pid]
  if (!pi || pi.account !== connected(account).id) fail(`No such payment_intent: '${pid}'`, "resource_missing", 404)
  return pi
}
// Capture: the seller's account gets the charge, the platform its fee.
function settle(pi) {
  db.charges[pi.latest_charge].captured = true
  pi.amount_received = pi.amount
  const fee = pi.application_fee_amount ?? 0
  if (fee) db.application_fees[id("fee")] = { object: "application_fee", amount: fee, amount_refunded: 0,
    account: pi.account, charge: pi.latest_charge }
  db.accounts[pi.account].balance += pi.amount - fee
}

const routes = [
  ["POST", /^\/v1\/customers$/, b => {
    const c = { id: id("cus"), object: "customer", email: b.email ?? null, name: b.name ?? null, metadata: b.metadata ?? {} }
    return db.customers[c.id] = c
  }],
  ["POST", /^\/v1\/customers\/([^/]+)$/, (b, [cid]) => Object.assign(need("customers", cid), b)],
  ["POST", /^\/v1\/payment_intents$/, (b, _m, _q, account) => {
    const acct = connected(account)
    if (!acct.charges_enabled) fail("Your account cannot currently make charges.", "account_invalid")
    const pi = { id: id("pi"), object: "payment_intent", amount: int(b.amount), currency: b.currency, account: acct.id,
      capture_method: b.capture_method ?? "automatic", status: "requires_payment_method", metadata: b.metadata ?? {},
      application_fee_amount: b.application_fee_amount === undefined ? null : Number(b.application_fee_amount),
      description: b.description ?? null, latest_charge: null, amount_received: 0, created: now(), last_payment_error: null }
    if (pi.application_fee_amount !== null && (!Number.isInteger(pi.application_fee_amount) || pi.application_fee_amount > pi.amount))
      fail("application_fee_amount must be an integer no greater than amount")
    pi.client_secret = pi.id + "_secret_" + crypto.randomBytes(8).toString("hex")
    return db.payment_intents[pi.id] = pi
  }],
  ["GET", /^\/v1\/payment_intents\/([^/]+)$/, (_b, [pid], _q, account) => intentOn(pid, account)],
  // What Stripe.js does in the browser (initialized with the seller's account).
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/confirm$/, (b, [pid], _q, account) => {
    const pi = intentOn(pid, account)
    if (!["requires_payment_method", "requires_confirmation"].includes(pi.status)) fail("Already confirmed", "payment_intent_unexpected_state")
    if (b.payment_method === "pm_card_chargeDeclined") {
      pi.last_payment_error = { code: "card_declined" }
      fail("Your card was declined.", "card_declined", 402)
    }
    const charge = { id: id("ch"), object: "charge", amount: pi.amount, captured: false, payment_intent: pi.id, refunded: 0 }
    db.charges[charge.id] = charge
    pi.latest_charge = charge.id
    pi.status = pi.capture_method === "manual" ? "requires_capture" : "succeeded"
    if (pi.status === "succeeded") settle(pi)
    return pi
  }],
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/capture$/, (_b, [pid], _q, account) => {
    const pi = intentOn(pid, account)
    if (pi.status !== "requires_capture") {
      const e = new StripeError(400, "invalid_request_error", "This PaymentIntent could not be captured", "payment_intent_unexpected_state")
      e.payment_intent = pi
      throw e
    }
    pi.status = "succeeded"
    settle(pi)
    return pi
  }],
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/cancel$/, (_b, [pid], _q, account) => {
    const pi = intentOn(pid, account)
    if (pi.status === "succeeded") fail("You cannot cancel this PaymentIntent because it has a status of succeeded", "payment_intent_unexpected_state")
    if (pi.status === "canceled") fail("This PaymentIntent is already canceled", "payment_intent_unexpected_state")
    pi.status = "canceled"
    return pi
  }],
  ["POST", /^\/v1\/refunds$/, (b, _m, _q, account) => {
    const pi = intentOn(b.payment_intent, account)
    if (pi.status !== "succeeded") fail("This PaymentIntent has no captured charge to refund", "charge_not_refundable")
    const charge = db.charges[pi.latest_charge]
    const amount = b.amount ? int(b.amount) : charge.amount - charge.refunded
    if (charge.refunded + amount > charge.amount) fail("Refund amount is greater than unrefunded amount on charge", "amount_too_large")
    charge.refunded += amount
    let fee_refunded = 0
    const fee = Object.values(db.application_fees).find(f => f.charge === charge.id)
    if (fee && b.refund_application_fee === "true") {
      // Proportional, cumulative: the fee share of everything refunded so far.
      const due = charge.refunded === charge.amount ? fee.amount : Math.round(fee.amount * charge.refunded / charge.amount)
      fee_refunded = due - fee.amount_refunded
      fee.amount_refunded = due
    }
    const acct = db.accounts[pi.account]
    acct.balance -= amount - fee_refunded
    const r = { id: id("re"), object: "refund", amount, charge: charge.id, payment_intent: pi.id, status: "succeeded",
      account: pi.account, application_fee_refunded: fee_refunded }
    return db.refunds[r.id] = r
  }],
  ["POST", /^\/v1\/accounts$/, (b, _m, _q, account) => {
    if (account) fail("Accounts are created by the platform")
    if (b.type !== "standard") fail("Unsupported account type in the stub (direct charges use standard)")
    const a = { id: id("acct"), object: "account", type: "standard", country: b.country, metadata: b.metadata ?? {},
      details_submitted: false, charges_enabled: false, payouts_enabled: false,
      requirements: { currently_due: ["external_account", "tos_acceptance.date"], past_due: [], disabled_reason: "requirements.past_due" },
      balance: 0 }
    return db.accounts[a.id] = a
  }],
  ["GET", /^\/v1\/accounts\/([^/]+)$/, (_b, [aid]) => need("accounts", aid)],
  ["POST", /^\/v1\/account_links$/, b => {
    need("accounts", b.account)
    if (b.type !== "account_onboarding" || !/^https?:\/\//.test(b.return_url ?? "") || !/^https?:\/\//.test(b.refresh_url ?? ""))
      fail("Invalid account link")
    return { object: "account_link", url: `https://connect.stripe.test/setup/${b.account}`, expires_at: now() + 300 }
  }],
  // ---- test helpers ----
  ["POST", /^\/__test\/accounts\/([^/]+)\/complete$/, (_b, [aid]) => Object.assign(need("accounts", aid), {
    details_submitted: true, charges_enabled: true, payouts_enabled: true,
    requirements: { currently_due: [], past_due: [], disabled_reason: null } })],
  // Stripe releasing an uncaptured authorization after 7 days.
  ["POST", /^\/__test\/payment_intents\/([^/]+)\/expire$/, (_b, [pid]) => {
    const pi = need("payment_intents", pid)
    if (pi.status !== "requires_capture") fail("Only an uncaptured authorization expires")
    pi.status = "canceled"
    return pi
  }],
  ["GET", /^\/__test\/state$/, () => db],
]

http.createServer((req, res) => {
  let body = ""
  req.on("data", chunk => body += chunk)
  req.on("end", () => {
    const url = new URL(req.url, "http://stub")
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": id("req") })
      res.end(JSON.stringify(payload))
    }
    try {
      if (!url.pathname.startsWith("/__test/") && !/^Bearer (sk|rk)_test_/.test(req.headers.authorization ?? ""))
        throw new StripeError(401, "invalid_request_error", "Invalid API Key provided")
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw new StripeError(404, "invalid_request_error", `Unrecognized request URL (${req.method}: ${url.pathname})`)
      const key = req.method === "POST" && req.headers["idempotency-key"]
      const scope = key ? `${req.method} ${url.pathname} ${req.headers["stripe-account"] ?? ""} ${key}` : null
      if (scope && db.idem[scope]) {
        if (db.idem[scope].body !== body) throw new StripeError(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.")
        return send(db.idem[scope].status, db.idem[scope].payload)
      }
      const account = req.headers["stripe-account"]
      const payload = route[2](req.method === "POST" ? parseForm(body) : {}, route[1].exec(url.pathname).slice(1),
        url.searchParams, typeof account === "string" ? account : undefined)
      if (scope) db.idem[scope] = { body, status: 200, payload }
      send(200, payload)
    } catch (e) {
      if (!(e instanceof StripeError)) { console.error(e); e = new StripeError(500, "api_error", String(e.message)) }
      send(e.status, { error: { type: e.type, message: e.message, code: e.code, ...(e.payment_intent ? { payment_intent: e.payment_intent } : {}) } })
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`stripe stub listening on http://127.0.0.1:${port}`))
