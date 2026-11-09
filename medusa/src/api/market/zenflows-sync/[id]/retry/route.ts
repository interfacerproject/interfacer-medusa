import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../../../market-guard"
import { buyerScene } from "../../../../../storefront/dev"
import { INTERFACER_MODULE } from "../../../../../modules/interfacer"
import type InterfacerService from "../../../../../modules/interfacer/service"
import { runZenflowsSync, syncView } from "../../../../../modules/interfacer/zenflows-outbox"
import { refuse } from "../../../../../modules/interfacer/checkout-guard"

// Idempotent: advances the row now (ignoring backoff), still reconciling first.
// Only the order's buyer or seller may ask; others get the same reason as for
// an unknown row, so sync ids cannot be probed.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
    res.status(400).json({ reason: "invalid_body: retry accepts only an empty object" })
    return
  }
  const person = (await buyerScene(req)).buyer_person_id
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const [row] = await integration.listZenflowsSyncs({ id: req.params.id })
  const [receipt] = row ? await integration.listReaReceipts({ id: row.receipt_id }) : []
  if (!receipt || ![receipt.provider_id, receipt.receiver_id].includes(person)) refuse("zenflows_sync_not_found")
  try { res.json({ sync: syncView(await runZenflowsSync(integration, row.id)) }) }
  catch (e) { res.status(503).json({ reason: "zenflows_sync_deferred", detail: (e as Error).message }) }
}
