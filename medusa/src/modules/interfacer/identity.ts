import type { MedusaContainer, ICustomerModuleService } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { requireLocalFixture } from "./deployment"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"

export async function bindIdentity(container: MedusaContainer, customerId: unknown, personId: unknown) {
  requireLocalFixture()
  if (typeof customerId !== "string" || !customerId.trim() ||
      typeof personId !== "string" || !personId.trim() || personId.length > 1000) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "customerId and personId are required")
  }
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock("interfacer-identity-bind-v1", async () => {
    const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER)
    const customer = await customers.retrieveCustomer(customerId)
    if (!customer.has_account) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "registered_customer_required")
    const [previous] = await integration.listIdentityLinks({ customer_id: customerId })
    if (previous) {
      if (previous.person_id !== personId) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "identity_rebind_forbidden")
      return previous
    }
    if ((await integration.listIdentityLinks({ person_id: personId })).length) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "person_already_bound")
    }
    return integration.createIdentityLinks({ customer_id: customerId, person_id: personId })
  })
}
