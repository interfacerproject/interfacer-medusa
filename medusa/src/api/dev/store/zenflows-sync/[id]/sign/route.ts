// Enforced authz relay, step 2 (see zenflows-outbox.ts relaySignature).
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { allowStorefront, buyerScene } from "../../../../../../storefront/dev"
import { refuse } from "../../../../../../modules/interfacer/checkout-guard"
import { INTERFACER_MODULE } from "../../../../../../modules/interfacer"
import type InterfacerService from "../../../../../../modules/interfacer/service"
import { relaySignature, syncView } from "../../../../../../modules/interfacer/zenflows-outbox"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const b = req.body as Record<string, unknown> | undefined
  if (!b || Array.isArray(b) || Object.keys(b).sort().join(",") !== "body,signature,step" ||
      !["process", "create", "transfer"].includes(String(b.step)) || typeof b.body !== "string" ||
      typeof b.signature !== "string") throw new MedusaError(MedusaError.Types.INVALID_DATA, "invalid_relay_body")
  const person = (await buyerScene(req)).buyer_person_id
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const [row] = await integration.listZenflowsSyncs({ id: req.params.id })
  if (!row || (row.payload as { provider?: string }).provider !== person) refuse("seller_order_required")
  const out = await relaySignature(integration, row.id, b.step as "process" | "create" | "transfer", b.body, b.signature)
  res.json({ sync: syncView(out.sync) })
}
