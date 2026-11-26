// After-sale services: cancellations, returns and refunds (release 4ku.2).
//
// Who may do what (each step is a signed operation of that person):
// - buyer:  open a case (cancellation before the milestone, return within the
//           return window after it), withdraw their own open case.
// - seller: accept or reject a case; confirm a returned item arrived and
//           refund it (full or partial); refund an order of theirs at will.
// The physical-return fact (returned_at, signed by the seller) and the
// financial refund are separate rows. Every refund also takes the seller's
// proportional share back: from the pending payout, or, when it was already
// transferred, by reversing that part of the Stripe transfer.
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { dirname, join } from "node:path"
import { cancelOrderWorkflow, refundPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { verifyCommerceOperation } from "./zenflows-person"
import { requireCommerceMode } from "./deployment"
import { addDays, paymentSettings, sellerShareOfRefunds, toCents } from "./payments"
import { stripeApi } from "./stripe-connect"
import {
  buyerOfOrder, orderPayment, publicPayout, readPaidOrder, refundedCents, refuse, sellerOfOrder, type PaidOrder,
} from "./settlement"

export type CaseKind = "cancellation" | "return"
export type CaseStatus = "requested" | "accepted" | "rejected" | "withdrawn" | "returned" | "refunded"
export const OPEN_STATUSES: CaseStatus[] = ["requested", "accepted", "returned"]

export const CASE_OPS = {
  open: "commerce.order.case.open",
  withdraw: "commerce.order.case.withdraw",
  respond: "commerce.order.case.respond",
  returned: "commerce.order.case.returned",
  refund: "commerce.order.refund",
} as const

// Medusa 2.10.3's own refund credit line (what its cancel workflow uses before
// refunding): not re-exported by core-flows, so loaded from its pinned file.
const { createOrderRefundCreditLinesWorkflow } = require(join(dirname(require.resolve("@medusajs/core-flows")),
  "order/workflows/payments/create-order-refund-credit-lines.js")) as {
    createOrderRefundCreditLinesWorkflow: typeof refundPaymentWorkflow }

const invalid = (reason: string): never => { throw new MedusaError(MedusaError.Types.INVALID_DATA, reason) }
const integrationOf = (c: MedusaContainer) => c.resolve<InterfacerService>(INTERFACER_MODULE)
const ID = /^[A-Za-z0-9_]{1,80}$/

// ---- pure rules (unit-tested) ----

export type OrderFacts = {
  canceled: boolean
  captured: boolean
  paid_cents: number
  refunded_cents: number
  milestone_at: Date | null // delivered (stock) / produced and handed over (build)
  open_case: boolean
}

// Whether the buyer may open a case of this kind now; a reason when not.
export function caseEligibility(kind: CaseKind, facts: OrderFacts, return_window_days: number, now = new Date()):
  { ok: true } | { ok: false; reason: string } {
  if (facts.canceled) return { ok: false, reason: "order_canceled" }
  if (!facts.captured) return { ok: false, reason: "captured_payment_required" }
  if (facts.refunded_cents >= facts.paid_cents) return { ok: false, reason: "order_fully_refunded" }
  if (facts.open_case) return { ok: false, reason: "aftersale_case_open" }
  if (kind === "cancellation" && facts.milestone_at) return { ok: false, reason: "cancellation_after_handover" }
  if (kind === "return") {
    if (!facts.milestone_at) return { ok: false, reason: "return_before_handover" }
    if (now > addDays(facts.milestone_at, return_window_days)) return { ok: false, reason: "return_window_closed" }
  }
  return { ok: true }
}

type Transition = "withdraw" | "accept" | "reject" | "returned" | "refunded"
// The case lifecycle. Anything not listed is refused.
const NEXT: Record<CaseKind, Partial<Record<CaseStatus, Partial<Record<Transition, CaseStatus>>>>> = {
  cancellation: {
    requested: { withdraw: "withdrawn", reject: "rejected", accept: "accepted" },
    accepted: { refunded: "refunded" },
  },
  return: {
    requested: { withdraw: "withdrawn", reject: "rejected", accept: "accepted" },
    accepted: { withdraw: "withdrawn", returned: "returned" },
    returned: { refunded: "refunded" },
  },
}
export function nextCaseStatus(kind: CaseKind, status: CaseStatus, transition: Transition): CaseStatus {
  const next = NEXT[kind][status]?.[transition]
  if (!next) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "aftersale_transition_forbidden")
  return next
}

// Strict signed params: exact keys, bounded strings, integer cents.
function params(body: unknown, keys: string[]): Record<string, any> {
  const b = body as Record<string, unknown> | undefined
  if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).sort().join(",") !== [...keys].sort().join(","))
    invalid("invalid_aftersale_params")
  for (const [k, v] of Object.entries(b!)) {
    if (k.endsWith("_cents") ? !Number.isSafeInteger(v) || (v as number) <= 0
      : typeof v !== "string" || v.length > 2000) invalid("invalid_aftersale_params")
  }
  return b!
}
const signer = (auth: unknown) => {
  const person = (auth as { envelope?: { person_id?: unknown } } | undefined)?.envelope?.person_id
  if (typeof person !== "string") invalid("invalid_aftersale_params")
  return person as string
}

// ---- order facts ----

async function factsOf(container: MedusaContainer, order: PaidOrder) {
  const integration = integrationOf(container)
  const payment = orderPayment(order)
  const [receipt] = await integration.listReaReceipts({ order_id: order.id })
  const cases = await integration.listAfterSaleCases({ order_id: order.id }, { order: { created_at: "ASC" } })
  return {
    payment, receipt, cases,
    facts: {
      canceled: order.status === "canceled",
      captured: !!payment.captured_at && !payment.canceled_at,
      paid_cents: toCents(payment.amount),
      refunded_cents: refundedCents(payment),
      milestone_at: receipt ? new Date(receipt.has_point_in_time) : null,
      open_case: cases.some(c => OPEN_STATUSES.includes(c.status as CaseStatus)),
    } satisfies OrderFacts,
  }
}

async function parties(container: MedusaContainer, order: PaidOrder) {
  const [buyer, seller] = await Promise.all([buyerOfOrder(container, order), sellerOfOrder(container, order)])
  return { buyer, seller: seller.seller_person_id, kind: seller.kind }
}

const settlementLock = (container: MedusaContainer, orderId: string, work: () => Promise<any>) =>
  integrationOf(container).withProjectionLock("interfacer-settlement:" + orderId, work)

// ---- buyer ----

export async function openCase(container: MedusaContainer, orderId: string, body: unknown, auth: unknown) {
  requireCommerceMode()
  const p = params(body, ["order_id", "kind", "reason"])
  if (p.order_id !== orderId || !["cancellation", "return"].includes(p.kind) || !p.reason.trim())
    invalid("invalid_aftersale_params")
  const person = signer(auth)
  return settlementLock(container, orderId, async () => {
    const order = await readPaidOrder(container, orderId)
    const who = await parties(container, order)
    // Same answer for a foreign or unknown order: no probing other people's orders.
    if (who.buyer !== person) refuse("buyer_order_required")
    await verifyCommerceOperation(auth, CASE_OPS.open, p, person)
    const { facts } = await factsOf(container, order)
    const ok = caseEligibility(p.kind, facts, paymentSettings().return_window_days)
    if (!ok.ok) refuse(ok.reason)
    return integrationOf(container).createAfterSaleCases({ order_id: orderId, kind: p.kind,
      buyer_person_id: person, seller_person_id: who.seller, reason: p.reason.trim() } as any)
  })
}

export async function withdrawCase(container: MedusaContainer, orderId: string, caseId: string, body: unknown, auth: unknown) {
  requireCommerceMode()
  const p = params(body, ["order_id", "case_id"])
  if (p.order_id !== orderId || p.case_id !== caseId) invalid("invalid_aftersale_params")
  const person = signer(auth)
  return settlementLock(container, orderId, async () => {
    const row = await readCase(container, orderId, caseId)
    if (row.buyer_person_id !== person) refuse("buyer_order_required")
    await verifyCommerceOperation(auth, CASE_OPS.withdraw, p, person)
    const status = nextCaseStatus(row.kind, row.status, "withdraw")
    return integrationOf(container).updateAfterSaleCases({ id: row.id, status, closed_at: new Date() } as any)
  })
}

// ---- seller ----

async function readCase(container: MedusaContainer, orderId: string, caseId: string) {
  if (!ID.test(caseId)) invalid("invalid_aftersale_params")
  const [row] = await integrationOf(container).listAfterSaleCases({ id: caseId, order_id: orderId })
  if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, "aftersale_case_not_found")
  return row as any as { id: string; order_id: string; kind: CaseKind; status: CaseStatus
    buyer_person_id: string; seller_person_id: string }
}

export async function respondCase(container: MedusaContainer, orderId: string, caseId: string, body: unknown, auth: unknown) {
  requireCommerceMode()
  const p = params(body, ["order_id", "case_id", "decision", "note"])
  if (p.order_id !== orderId || p.case_id !== caseId || !["accept", "reject"].includes(p.decision))
    invalid("invalid_aftersale_params")
  if (p.decision === "reject" && !p.note.trim()) invalid("aftersale_reject_reason_required")
  const person = signer(auth)
  return settlementLock(container, orderId, async () => {
    const row = await readCase(container, orderId, caseId)
    if (row.seller_person_id !== person) refuse("seller_order_required")
    await verifyCommerceOperation(auth, CASE_OPS.respond, p, person)
    const status = nextCaseStatus(row.kind, row.status, p.decision)
    const integration = integrationOf(container)
    const now = new Date()
    await integration.updateAfterSaleCases({ id: row.id, status, seller_note: p.note.trim() || null,
      responded_at: now, ...(status === "rejected" ? { closed_at: now } : {}) } as any)
    // An accepted cancellation is carried out at once: the order is canceled
    // natively (its unit is free again) and the buyer refunded in full.
    if (row.kind === "cancellation" && status === "accepted") {
      const order = await readPaidOrder(container, orderId)
      const { facts } = await factsOf(container, order)
      const refund = await integration.createRefunds({ order_id: orderId, case_id: row.id,
        amount_cents: facts.paid_cents - facts.refunded_cents, reason: "cancellation", requested_by: person } as any)
      await carryOutRefund(container, refund.id, { cancel: true, actor: person })
      await integration.updateAfterSaleCases({ id: row.id, status: nextCaseStatus(row.kind, status, "refunded"),
        closed_at: new Date() } as any)
    }
    return integration.retrieveAfterSaleCase(row.id)
  })
}

// The seller signs that the returned item arrived, and how much is refunded
// (full by default; less for e.g. a damaged item, with a note saying why).
export async function confirmReturn(container: MedusaContainer, orderId: string, caseId: string, body: unknown, auth: unknown) {
  requireCommerceMode()
  const p = params(body, ["order_id", "case_id", "refund_cents", "note"])
  if (p.order_id !== orderId || p.case_id !== caseId) invalid("invalid_aftersale_params")
  const person = signer(auth)
  return settlementLock(container, orderId, async () => {
    const row = await readCase(container, orderId, caseId)
    if (row.seller_person_id !== person) refuse("seller_order_required")
    await verifyCommerceOperation(auth, CASE_OPS.returned, p, person)
    const order = await readPaidOrder(container, orderId)
    const { facts } = await factsOf(container, order)
    const remaining = facts.paid_cents - facts.refunded_cents
    if (p.refund_cents > remaining) refuse("refund_exceeds_payment")
    if (p.refund_cents < remaining && !p.note.trim()) invalid("partial_refund_note_required")
    const integration = integrationOf(container)
    const returned = nextCaseStatus(row.kind, row.status, "returned")
    await integration.updateAfterSaleCases({ id: row.id, status: returned, returned_at: new Date(),
      seller_note: p.note.trim() || null } as any)
    const refund = await integration.createRefunds({ order_id: orderId, case_id: row.id,
      amount_cents: p.refund_cents, reason: p.note.trim() || "return", requested_by: person } as any)
    await carryOutRefund(container, refund.id, { actor: person })
    await integration.updateAfterSaleCases({ id: row.id, status: nextCaseStatus(row.kind, returned, "refunded"),
      closed_at: new Date() } as any)
    return integration.retrieveAfterSaleCase(row.id)
  })
}

// A refund the seller decides on their own (goodwill, a late or faulty build).
export async function refundOrder(container: MedusaContainer, orderId: string, body: unknown, auth: unknown) {
  requireCommerceMode()
  const p = params(body, ["order_id", "amount_cents", "reason"])
  if (p.order_id !== orderId || !p.reason.trim()) invalid("invalid_aftersale_params")
  const person = signer(auth)
  return settlementLock(container, orderId, async () => {
    const order = await readPaidOrder(container, orderId)
    const who = await parties(container, order)
    if (who.seller !== person) refuse("seller_order_required")
    await verifyCommerceOperation(auth, CASE_OPS.refund, p, person)
    const { facts } = await factsOf(container, order)
    if (facts.canceled) refuse("order_canceled")
    if (!facts.captured) refuse("captured_payment_required")
    if (p.amount_cents > facts.paid_cents - facts.refunded_cents) refuse("refund_exceeds_payment")
    const refund = await integrationOf(container).createRefunds({ order_id: orderId, amount_cents: p.amount_cents,
      reason: p.reason.trim(), requested_by: person } as any)
    await carryOutRefund(container, refund.id, { actor: person })
    return integrationOf(container).retrieveRefund(refund.id)
  })
}

// ---- the refund itself (resumable; callers hold the settlement lock) ----

const refundNote = (id: string) => "interfacer:" + id

export async function carryOutRefund(container: MedusaContainer, refundId: string,
  opts: { cancel?: boolean; actor: string }) {
  const integration = integrationOf(container)
  const refund = await integration.retrieveRefund(refundId) as any
  if (refund.status === "done") return refund
  try {
    let order = await readPaidOrder(container, refund.order_id)
    let payment = orderPayment(order)
    const already = (payment.refunds ?? []).some(r => r.note === refundNote(refund.id))
    if (opts.cancel) {
      // Native cancel: refunds every captured payment, cancels uncaptured ones
      // and releases the stock reservation. Idempotent through the status.
      if (order.status !== "canceled")
        await cancelOrderWorkflow(container).run({ input: { order_id: order.id, canceled_by: opts.actor } })
    } else if (!already) {
      const { data: [withSummary] } = await container.resolve("query").graph({
        entity: "order", filters: { id: order.id }, fields: ["id", "summary.*"] })
      const pending = Number((withSummary as any)?.summary?.pending_difference ?? 0)
      const amount = refund.amount_cents / 100
      // Resume: a credit line already added by an interrupted attempt stays.
      if (!(pending <= -amount + 1e-9))
        await createOrderRefundCreditLinesWorkflow(container).run({ input: {
          order_id: order.id, amount, created_by: opts.actor } as any })
      await refundPaymentWorkflow(container).run({ input: {
        payment_id: payment.id, amount, created_by: opts.actor, note: refundNote(refund.id) } as any })
    }
    order = await readPaidOrder(container, refund.order_id)
    payment = orderPayment(order)
    const reversal = await takeBackSellerShare(container, refund, refundedCents(payment), order.status === "canceled")
    await integration.updateRefunds({ id: refund.id, status: "done", last_error: null, ...reversal } as any)
  } catch (error) {
    await integration.updateRefunds({ id: refund.id,
      last_error: String((error as Error)?.message ?? error).slice(0, 500) } as any)
    throw error
  }
  return integration.retrieveRefund(refundId)
}

// The seller's share of what was refunded so far comes back to the platform:
// a held payout shrinks (or is canceled), a transferred one is partly reversed.
async function takeBackSellerShare(container: MedusaContainer, refund: { id: string; order_id: string },
  refunded_total_cents: number, canceled: boolean) {
  const integration = integrationOf(container)
  const [payout] = await integration.listPayouts({ order_id: refund.order_id }) as any[]
  if (!payout) return {}
  if (payout.status === "held" || payout.status === "blocked") {
    if (canceled || refunded_total_cents >= payout.gross_cents)
      await integration.updatePayouts({ id: payout.id, status: "canceled" } as any)
    return {}
  }
  if (payout.status !== "transferred") return {}
  // Seller's share of all refunds, minus what pre-transfer refunds already kept back.
  const share = sellerShareOfRefunds(payout, Math.min(refunded_total_cents, payout.gross_cents))
  const target = Math.min(payout.transferred_cents, Math.max(0, share - (payout.net_cents - payout.transferred_cents)))
  const delta = target - payout.reversed_cents
  if (delta <= 0) return {}
  const reversal = await stripeApi().transfers.createReversal(payout.transfer_id, {
    amount: delta, metadata: { interfacer_refund_id: refund.id, interfacer_order_id: refund.order_id },
  }, { idempotencyKey: "interfacer-refund-reversal:" + refund.id })
  await integration.updatePayouts({ id: payout.id, reversed_cents: payout.reversed_cents + reversal.amount } as any)
  return { reversal_cents: reversal.amount, reversal_id: reversal.id }
}

// Job: finish refunds an earlier attempt left pending (crash, Stripe outage).
export async function resumePendingRefunds(container: MedusaContainer, now = new Date()) {
  const integration = integrationOf(container)
  const pending = await integration.listRefunds({ status: "pending", updated_at: { $lte: new Date(now.getTime() - 60_000) } } as any,
    { take: 20, order: { created_at: "ASC" } })
  let done = 0
  for (const r of pending as any[]) {
    try {
      await settlementLock(container, r.order_id, async () => {
        const row = r.case_id ? await integration.retrieveAfterSaleCase(r.case_id) as any : null
        await carryOutRefund(container, r.id, { cancel: row?.kind === "cancellation", actor: r.requested_by })
        // Close the case the interrupted refund belonged to.
        if (row && (row.status === "accepted" || row.status === "returned"))
          await integration.updateAfterSaleCases({ id: row.id, status: "refunded", closed_at: new Date() } as any)
      })
      done++
    } catch { /* last_error recorded; retried next run */ }
  }
  return done
}

// ---- reads ----

// What the buyer or the seller of an order may see about its after-sale:
// cases, refunds, what they can do now; the seller also sees their payout.
export async function aftersaleView(container: MedusaContainer, orderId: string, person: string) {
  if (!ID.test(orderId)) invalid("invalid_aftersale_params")
  const order = await readPaidOrder(container, orderId)
  const who = await parties(container, order)
  const role = who.buyer === person ? "buyer" : who.seller === person ? "seller" : null
  if (!role) refuse("order_party_required")
  const integration = integrationOf(container)
  const { facts, cases } = await factsOf(container, order)
  const refunds = await integration.listRefunds({ order_id: orderId }, { order: { created_at: "ASC" } })
  const s = paymentSettings()
  const [payout] = role === "seller" ? await integration.listPayouts({ order_id: orderId }) : []
  const allowed = (kind: CaseKind) => caseEligibility(kind, facts, s.return_window_days)
  return {
    order_id: orderId, role, kind: who.kind, provider: payment_provider(order),
    // The other party, so the GUI can notify them through the Interfacer inbox.
    counterpart_person_id: role === "buyer" ? who.seller : who.buyer,
    paid_cents: facts.paid_cents, refunded_cents: facts.refunded_cents, canceled: facts.canceled,
    milestone_at: facts.milestone_at,
    return_until: facts.milestone_at ? addDays(facts.milestone_at, s.return_window_days) : null,
    can: role === "buyer"
      ? { cancellation: allowed("cancellation"), return: allowed("return") }
      : { refund: facts.captured && !facts.canceled && facts.refunded_cents < facts.paid_cents },
    cases: cases.map(c => ({ id: c.id, kind: c.kind, status: c.status, reason: c.reason, seller_note: c.seller_note,
      created_at: c.created_at, responded_at: c.responded_at, returned_at: c.returned_at, closed_at: c.closed_at })),
    refunds: refunds.map((r: any) => ({ id: r.id, case_id: r.case_id, amount_cents: r.amount_cents, reason: r.reason,
      status: r.status, created_at: r.created_at, ...(role === "seller" ? { reversal_cents: r.reversal_cents } : {}) })),
    ...(role === "seller" ? { payout: payout ? publicPayout(payout) : null } : {}),
  }
}

function payment_provider(order: PaidOrder) {
  return orderPayment(order).provider_id
}

// Seller console: open cases on the seller's orders, oldest first.
export async function openCasesFor(container: MedusaContainer, person: string) {
  const rows = await integrationOf(container).listAfterSaleCases({ seller_person_id: person, status: OPEN_STATUSES },
    { take: 200, order: { created_at: "ASC" } })
  return rows.map(c => ({ id: c.id, order_id: c.order_id, kind: c.kind, status: c.status, reason: c.reason,
    created_at: c.created_at }))
}
