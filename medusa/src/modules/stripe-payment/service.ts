// Stripe Connect DIRECT CHARGES as a Medusa payment provider (pp_stripe_stripe).
//
// The buyer pays the SELLER: every PaymentIntent lives on the seller's own
// (Standard) Stripe account, which is the merchant of record. Interfacer's
// commission is an application fee Stripe moves to the platform when the
// payment is captured; a refund gives the commission back proportionally
// (refund_application_fee). Card details go from the browser to Stripe only.
//
// Sessions are created only by the marketplace's own route
// (/market/store/payment), which computes the seller account and the fee from
// the order's settlement terms; the native session route refuses this
// provider, and cart completion re-checks the PaymentIntent on Stripe.
import Stripe from "stripe"
import { AbstractPaymentProvider, MathBN, MedusaError, PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput, AuthorizePaymentOutput, CancelPaymentInput, CancelPaymentOutput, CapturePaymentInput,
  CapturePaymentOutput, DeletePaymentInput, DeletePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput,
  InitiatePaymentInput, InitiatePaymentOutput, ProviderWebhookPayload, RefundPaymentInput, RefundPaymentOutput,
  RetrievePaymentInput, RetrievePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput, WebhookActionResult,
} from "@medusajs/framework/types"
import { stripeOptions } from "../interfacer/stripe-connect"

type Options = { apiKey: string; webhookSecret: string; apiBase?: string }

// What the marketplace route puts in the session data (trusted: only it creates
// sessions for this provider).
export type DirectChargeRequest = {
  interfacer_direct: { stripe_account: string; application_fee_amount: number; order_reference: string }
}

const ACCOUNT = /^acct_[A-Za-z0-9]+$/
// Medusa hands amounts as numbers, strings or BigNumbers, in major units.
export const toMinor = (amount: unknown, currency: string) => {
  if (currency.toLowerCase() !== "eur") throw new MedusaError(MedusaError.Types.INVALID_DATA, "eur_only")
  const minor = Math.round(MathBN.convert(amount as any).toNumber() * 100)
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new MedusaError(MedusaError.Types.INVALID_DATA, "invalid_amount")
  return minor
}

// Stripe's PaymentIntent status as Medusa's session status.
export function sessionStatus(intent: Pick<Stripe.PaymentIntent, "status" | "last_payment_error">): PaymentSessionStatus {
  switch (intent.status) {
    case "requires_payment_method":
      return intent.last_payment_error ? PaymentSessionStatus.ERROR : PaymentSessionStatus.PENDING
    case "requires_action":
      return PaymentSessionStatus.REQUIRES_MORE
    case "requires_capture":
      return PaymentSessionStatus.AUTHORIZED
    case "succeeded":
      return PaymentSessionStatus.CAPTURED
    case "canceled":
      return PaymentSessionStatus.CANCELED
    default:
      return PaymentSessionStatus.PENDING
  }
}

// Session/payment data: the intent plus the account it lives on.
const stored = (intent: Stripe.PaymentIntent, stripe_account: string) =>
  ({ ...intent, stripe_account }) as unknown as Record<string, unknown>

function accountOf(data: Record<string, unknown> | undefined): { id: string; account: string } {
  const id = String(data?.id ?? ""), account = String(data?.stripe_account ?? "")
  if (!/^pi_[A-Za-z0-9]+$/.test(id) || !ACCOUNT.test(account))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "stripe_direct_payment_data_missing")
  return { id, account }
}

class InterfacerStripeDirectProvider extends AbstractPaymentProvider<Options> {
  static identifier = "stripe"
  protected stripe_: Stripe
  protected options_: Options

  static validateOptions(options: Record<string, unknown>) {
    if (!options.apiKey) throw new Error("Required option `apiKey` is missing")
  }

  constructor(cradle: Record<string, unknown>, options: Options) {
    super(cradle, options)
    this.options_ = options
    this.stripe_ = new Stripe(options.apiKey, stripeOptions(options.apiBase))
  }

  async initiatePayment({ amount, currency_code, data, context }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const req = (data as unknown as DirectChargeRequest | undefined)?.interfacer_direct
    const session_id = String((data as Record<string, unknown> | undefined)?.session_id ?? "")
    if (!req || !ACCOUNT.test(req.stripe_account) || !Number.isSafeInteger(req.application_fee_amount) ||
        req.application_fee_amount < 0)
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "stripe_direct_session_route_required")
    const minor = toMinor(amount, currency_code)
    if (req.application_fee_amount > minor) throw new MedusaError(MedusaError.Types.INVALID_DATA, "fee_exceeds_amount")
    const intent = await this.stripe_.paymentIntents.create({
      amount: minor, currency: currency_code.toLowerCase(),
      application_fee_amount: req.application_fee_amount,
      // Authorize now; capture at delivery (stock) or once the order exists (build).
      capture_method: "manual",
      automatic_payment_methods: { enabled: true },
      description: "Interfacer marketplace order",
      metadata: { session_id, interfacer_order_reference: req.order_reference },
    }, { stripeAccount: req.stripe_account, idempotencyKey: context?.idempotency_key ?? `interfacer-session:${session_id}` })
    return { id: intent.id, status: sessionStatus(intent), data: stored(intent, req.stripe_account) }
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const { id, account } = accountOf(data)
    const intent = await this.stripe_.paymentIntents.retrieve(id, {}, { stripeAccount: account })
    return { status: sessionStatus(intent), data: stored(intent, account) }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    return this.getPaymentStatus(input)
  }

  async capturePayment({ data, context }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const { id, account } = accountOf(data)
    try {
      const intent = await this.stripe_.paymentIntents.capture(id, {},
        { stripeAccount: account, idempotencyKey: context?.idempotency_key })
      return { data: stored(intent, account) }
    } catch (error) {
      // Already captured (a retry after a lost response): fine.
      const intent = (error as { payment_intent?: Stripe.PaymentIntent }).payment_intent
      if (intent?.status === "succeeded") return { data: stored(intent, account) }
      throw error
    }
  }

  async cancelPayment({ data, context }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    if (!data?.id) return { data }
    const { id, account } = accountOf(data)
    try {
      const intent = await this.stripe_.paymentIntents.cancel(id, {},
        { stripeAccount: account, idempotencyKey: context?.idempotency_key })
      return { data: stored(intent, account) }
    } catch (error) {
      // An authorization Stripe already released (expired) is canceled anyway.
      const intent = await this.stripe_.paymentIntents.retrieve(id, {}, { stripeAccount: account })
      if (intent.status === "canceled") return { data: stored(intent, account) }
      throw error
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  // The commission is given back in proportion to the refund.
  async refundPayment({ amount, data, context }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const { id, account } = accountOf(data)
    await this.stripe_.refunds.create({
      payment_intent: id, amount: toMinor(amount, String(data?.currency ?? "eur")), refund_application_fee: true,
    }, { stripeAccount: account, idempotencyKey: context?.idempotency_key })
    return { data }
  }

  async retrievePayment({ data }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const { id, account } = accountOf(data)
    return { data: stored(await this.stripe_.paymentIntents.retrieve(id, {}, { stripeAccount: account }), account) }
  }

  // The amount and fee are fixed when the session is created; a changed cart
  // gets a new session from the marketplace route, never an edited intent.
  async updatePayment({ data, amount, currency_code }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    if (toMinor(amount, currency_code) !== Number((data as Record<string, unknown>)?.amount))
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "stripe_direct_amount_fixed")
    return { status: sessionStatus(data as any), data }
  }

  // Connect webhook (events of connected accounts); verified with its secret.
  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const signature = payload.headers["stripe-signature"] as string
    const event = this.stripe_.webhooks.constructEvent(payload.rawData as string | Buffer, signature,
      this.options_.webhookSecret)
    const intent = event.data.object as Stripe.PaymentIntent
    const base = { session_id: intent.metadata?.session_id, amount: (intent.amount ?? 0) / 100 }
    switch (event.type) {
      case "payment_intent.amount_capturable_updated":
        return { action: PaymentActions.AUTHORIZED, data: base }
      case "payment_intent.succeeded":
        return { action: PaymentActions.SUCCESSFUL, data: base }
      case "payment_intent.payment_failed":
        return { action: PaymentActions.FAILED, data: base }
      case "payment_intent.canceled":
        return { action: PaymentActions.CANCELED, data: base }
      default:
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }
}

export default InterfacerStripeDirectProvider
