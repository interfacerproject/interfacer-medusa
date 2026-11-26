// Medusa's own Stripe payment provider (card and the other methods Stripe's
// Payment Element offers), registered as pp_stripe_stripe. The only change: a
// local Stripe stand-in can replace api.stripe.com in tests (STRIPE_API_BASE,
// refused in production by payments.ts). Payments are captured at checkout;
// the seller's share is transferred later (settlement.ts).
import Stripe from "stripe"
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { StripeProviderService } from "@medusajs/payment-stripe/dist/services"
import { stripeOptions } from "../interfacer/stripe-connect"

type Options = ConstructorParameters<typeof StripeProviderService>[1] & { apiBase?: string }

class InterfacerStripeProvider extends StripeProviderService {
  static identifier = "stripe"
  constructor(cradle: Record<string, unknown>, options: Options) {
    super(cradle, options)
    if (options.apiBase) this.stripe_ = new Stripe(options.apiKey, stripeOptions(options.apiBase))
  }
}

export default ModuleProvider(Modules.PAYMENT, { services: [InterfacerStripeProvider] })
