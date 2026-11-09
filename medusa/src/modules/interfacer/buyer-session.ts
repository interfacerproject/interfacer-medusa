import type { IAuthModuleService, ICustomerModuleService, MedusaContainer, ConfigModule } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, generateJwtToken, MedusaError, Modules } from "@medusajs/framework/utils"
import { randomBytes } from "node:crypto"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { buyerChallenges } from "./buyer-challenges"
import { refuse } from "./checkout-guard"
import { verifyZenflowsOperation } from "./zenflows-person"
import { requireCommerceMode } from "./deployment"
import type { SignedOperation } from "./signed-envelope"

// A native Medusa bearer account, enrolled only after proof of the key currently
// registered to the Person in the configured Zenflows registry. No key, email,
// customer id or receiver from the request is trusted as identity evidence.
export async function createBuyerSession(container: MedusaContainer, auth: unknown) {
  requireCommerceMode()
  const envelope = (auth as SignedOperation | undefined)?.envelope
  const person = envelope?.person_id
  const params = envelope?.params as { challenge?: unknown } | undefined
  if (typeof person !== "string" || typeof params?.challenge !== "string" ||
      Object.keys(params).join(",") !== "challenge") refuse("buyer_challenge_invalid")
  try { buyerChallenges.consume(params.challenge, person) } catch { refuse("buyer_challenge_invalid") }
  await verifyZenflowsOperation(auth, "commerce.session.create", params, person)

  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-buyer-session:" + person, async () => {
    const authModule = container.resolve<IAuthModuleService>(Modules.AUTH)
    const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER)
    const id = "authid_interfacer_" + person
    let identity
    try { identity = await authModule.retrieveAuthIdentity(id) }
    catch (e) { if (!(e instanceof MedusaError) || e.type !== MedusaError.Types.NOT_FOUND) throw e }
    if (!identity) {
      // No password or real email is provisioned/exposed. An interrupted first
      // enrollment may leave an unused customer, never a reusable proof/account.
      const customer = await customers.createCustomers({
        email: `interfacer-${randomBytes(16).toString("hex")}@market.invalid`, has_account: true,
      })
      identity = await authModule.createAuthIdentities({ id, app_metadata: {
        customer_id: customer.id, zenflows_person_id: person,
      } })
    }
    const customerId = identity.app_metadata?.customer_id
    if (identity.app_metadata?.zenflows_person_id !== person || typeof customerId !== "string")
      refuse("buyer_identity_reconciliation_required")
    const customer = await customers.retrieveCustomer(customerId)
    if (!customer.has_account) refuse("registered_customer_required")
    const [link] = await integration.listIdentityLinks({ person_id: person })
    if (link && (link.customer_id !== customerId || link.zenflows_person_id !== person)) refuse("identity_rebind_forbidden")
    if (!link) await integration.createIdentityLinks({ customer_id: customerId, person_id: person, zenflows_person_id: person })
    const config = container.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
    const http = config.projectConfig.http!
    const token = generateJwtToken({
      actor_id: customerId, actor_type: "customer", auth_identity_id: identity.id,
      app_metadata: { customer_id: customerId },
    }, { secret: http.jwtSecret!, expiresIn: "1h", jwtOptions: http.jwtOptions })
    return { token, customer_id: customerId, buyer_person_id: person, email: customer.email }
  })
}
