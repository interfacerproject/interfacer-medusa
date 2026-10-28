// Enforced authz relay, step 1 (see zenflows-outbox.ts nextWrite): only the
// Person named as this row's provider receives the exact body to sign.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowStorefront, buyerScene } from "../../../../../../storefront/dev"
import { refuse } from "../../../../../../modules/interfacer/checkout-guard"
import { INTERFACER_MODULE } from "../../../../../../modules/interfacer"
import type InterfacerService from "../../../../../../modules/interfacer/service"
import { nextWrite, syncView } from "../../../../../../modules/interfacer/zenflows-outbox"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const person = (await buyerScene(req)).buyer_person_id
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const [row] = await integration.listZenflowsSyncs({ id: req.params.id })
  if (!row || (row.payload as { provider?: string }).provider !== person) refuse("seller_order_required")
  const next = await nextWrite(integration, row.id)
  res.json({ sync: syncView(next.sync), ...(next.step ? { step: next.step, body: next.body } : {}) })
}
