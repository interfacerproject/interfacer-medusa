#!/usr/bin/env node
// LOCAL TEST STAND-IN for api.stripe.com: the slice of Stripe's HTTP API the
// marketplace uses (customers, PaymentIntents, refunds, Connect accounts,
// account/login links, transfers and reversals), with Stripe's own request
// encoding, idempotency keys and the money rules that matter here (no transfer
// beyond the charge, no reversal beyond the transfer, transfers only to ready
// accounts). Never a substitute for a run against Stripe's test mode.
// Test-only helpers live under /__test/. Usage: node scripts/stripe-stub.cjs [port]
const http = require("node:http")
const crypto = require("node:crypto")

const port = Number(process.argv[2] || process.env.STRIPE_STUB_PORT || 12111)
const db = { customers: {}, payment_intents: {}, charges: {}, refunds: {}, accounts: {}, transfers: {}, idem: {} }
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

function intentView(pi) { return { ...pi } }

const routes = [
  ["POST", /^\/v1\/customers$/, b => {
    const c = { id: id("cus"), object: "customer", email: b.email ?? null, name: b.name ?? null, metadata: b.metadata ?? {} }
    return db.customers[c.id] = c
  }],
  ["POST", /^\/v1\/customers\/([^/]+)$/, (b, [cid]) => Object.assign(need("customers", cid), b)],
  ["POST", /^\/v1\/payment_intents$/, b => {
    const pi = { id: id("pi"), object: "payment_intent", amount: int(b.amount), currency: b.currency,
      capture_method: b.capture_method ?? "automatic", status: "requires_payment_method", metadata: b.metadata ?? {},
      description: b.description ?? null, customer: b.customer ?? null, latest_charge: null, amount_received: 0,
      created: now(), last_payment_error: null }
    pi.client_secret = pi.id + "_secret_" + crypto.randomBytes(8).toString("hex")
    return db.payment_intents[pi.id] = pi
  }],
  ["GET", /^\/v1\/payment_intents\/([^/]+)$/, (_b, [pid]) => intentView(need("payment_intents", pid))],
  ["POST", /^\/v1\/payment_intents\/([^/]+)$/, (b, [pid]) => {
    const pi = need("payment_intents", pid)
    if (!["requires_payment_method", "requires_confirmation"].includes(pi.status)) fail("PaymentIntent cannot be updated", "payment_intent_unexpected_state")
    if (b.amount) pi.amount = int(b.amount)
    return intentView(pi)
  }],
  // What Stripe.js does in the browser when the buyer confirms the Payment Element.
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/confirm$/, (b, [pid]) => {
    const pi = need("payment_intents", pid)
    if (!["requires_payment_method", "requires_confirmation"].includes(pi.status)) fail("Already confirmed", "payment_intent_unexpected_state")
    if (b.payment_method === "pm_card_chargeDeclined") {
      pi.last_payment_error = { code: "card_declined" }
      fail("Your card was declined.", "card_declined", 402)
    }
    const charge = { id: id("ch"), object: "charge", amount: pi.amount, captured: pi.capture_method === "automatic",
      payment_intent: pi.id, refunded: 0, transferred: 0 }
    db.charges[charge.id] = charge
    pi.latest_charge = charge.id
    pi.status = pi.capture_method === "manual" ? "requires_capture" : "succeeded"
    if (pi.status === "succeeded") pi.amount_received = pi.amount
    return intentView(pi)
  }],
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/capture$/, (_b, [pid]) => {
    const pi = need("payment_intents", pid)
    if (pi.status !== "requires_capture") {
      const e = new StripeError(400, "invalid_request_error", "This PaymentIntent could not be captured", "payment_intent_unexpected_state")
      e.payment_intent = intentView(pi)
      throw e
    }
    pi.status = "succeeded"; pi.amount_received = pi.amount
    db.charges[pi.latest_charge].captured = true
    return intentView(pi)
  }],
  ["POST", /^\/v1\/payment_intents\/([^/]+)\/cancel$/, (_b, [pid]) => {
    const pi = need("payment_intents", pid)
    if (pi.status === "succeeded") fail("You cannot cancel this PaymentIntent because it has a status of succeeded", "payment_intent_unexpected_state")
    pi.status = "canceled"
    return intentView(pi)
  }],
  ["POST", /^\/v1\/refunds$/, b => {
    const pi = need("payment_intents", b.payment_intent)
    if (pi.status !== "succeeded") fail("This PaymentIntent has no captured charge to refund", "charge_not_refundable")
    const charge = db.charges[pi.latest_charge]
    const amount = b.amount ? int(b.amount) : charge.amount - charge.refunded
    if (charge.refunded + amount > charge.amount) fail("Refund amount is greater than unrefunded amount on charge", "amount_too_large")
    charge.refunded += amount
    const r = { id: id("re"), object: "refund", amount, charge: charge.id, payment_intent: pi.id, status: "succeeded" }
    return db.refunds[r.id] = r
  }],
  ["POST", /^\/v1\/accounts$/, b => {
    if (b.controller?.stripe_dashboard?.type !== "express" || b.controller?.fees?.payer !== "application" ||
        b.capabilities?.transfers?.requested !== "true") fail("Unsupported account shape in the stub")
    const a = { id: id("acct"), object: "account", country: b.country, metadata: b.metadata ?? {}, controller: b.controller,
      details_submitted: false, payouts_enabled: false, charges_enabled: false, capabilities: { transfers: "inactive" },
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
  ["POST", /^\/v1\/accounts\/([^/]+)\/login_links$/, (_b, [aid]) => {
    if (!need("accounts", aid).details_submitted) fail("Cannot create a login link for an account that has not completed onboarding")
    return { object: "login_link", url: `https://connect.stripe.test/express/${aid}` }
  }],
  ["POST", /^\/v1\/transfers$/, b => {
    const account = need("accounts", b.destination)
    if (account.capabilities.transfers !== "active") fail("Your destination account needs to have the transfers capability enabled", "insufficient_capabilities_for_transfer")
    const amount = int(b.amount)
    const charge = b.source_transaction ? need("charges", b.source_transaction) : fail("source_transaction required by this stub")
    if (!charge.captured) fail("The source transaction has not been captured")
    if (charge.transferred + amount > charge.amount - charge.refunded) fail("Insufficient funds from the source transaction", "balance_insufficient")
    charge.transferred += amount
    account.balance += amount
    const t = { id: id("tr"), object: "transfer", amount, amount_reversed: 0, currency: b.currency, destination: account.id,
      source_transaction: charge.id, transfer_group: b.transfer_group ?? null, metadata: b.metadata ?? {}, reversed: false,
      description: b.description ?? null, reversals: [] }
    return db.transfers[t.id] = t
  }],
  ["GET", /^\/v1\/transfers$/, (_b, _m, query) => ({ object: "list", has_more: false, url: "/v1/transfers",
    data: Object.values(db.transfers).filter(t => !query.get("transfer_group") || t.transfer_group === query.get("transfer_group")) })],
  ["POST", /^\/v1\/transfers\/([^/]+)\/reversals$/, (b, [tid]) => {
    const t = need("transfers", tid)
    const amount = b.amount ? int(b.amount) : t.amount - t.amount_reversed
    if (t.amount_reversed + amount > t.amount) fail("Reversal amount exceeds the transfer", "amount_too_large")
    t.amount_reversed += amount
    t.reversed = t.amount_reversed === t.amount
    db.accounts[t.destination].balance -= amount
    db.charges[t.source_transaction].transferred -= amount
    const r = { id: id("trr"), object: "transfer_reversal", amount, transfer: t.id, metadata: b.metadata ?? {} }
    t.reversals.push(r)
    return r
  }],
  // ---- test helpers ----
  ["POST", /^\/__test\/accounts\/([^/]+)\/complete$/, (_b, [aid]) => Object.assign(need("accounts", aid), {
    details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" },
    requirements: { currently_due: [], past_due: [], disabled_reason: null } })],
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
      const scope = key ? `${req.method} ${url.pathname} ${key}` : null
      if (scope && db.idem[scope]) {
        if (db.idem[scope].body !== body) throw new StripeError(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.")
        return send(db.idem[scope].status, db.idem[scope].payload)
      }
      const payload = route[2](req.method === "POST" ? parseForm(body) : {}, route[1].exec(url.pathname).slice(1), url.searchParams)
      if (scope) db.idem[scope] = { body, status: 200, payload }
      send(200, payload)
    } catch (e) {
      if (!(e instanceof StripeError)) { console.error(e); e = new StripeError(500, "api_error", String(e.message)) }
      send(e.status, { error: { type: e.type, message: e.message, code: e.code, ...(e.payment_intent ? { payment_intent: e.payment_intent } : {}) } })
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`stripe stub listening on http://127.0.0.1:${port}`))
