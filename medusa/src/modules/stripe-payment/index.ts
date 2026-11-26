// Stripe Connect direct charges (see service.ts), registered as pp_stripe_stripe.
import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import InterfacerStripeDirectProvider from "./service"

export default ModuleProvider(Modules.PAYMENT, { services: [InterfacerStripeDirectProvider] })
