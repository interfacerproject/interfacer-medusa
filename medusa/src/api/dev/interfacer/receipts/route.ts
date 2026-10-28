import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../local-guard"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"
import { withSync } from "../../../../modules/interfacer/zenflows-outbox"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const receipts = []
  for (let skip = 0; ; skip += 100) {
    const page = await integration.listReaReceipts({}, { skip, take: 100, order: { created_at: "ASC" } })
    const syncs = page.length ? await integration.listZenflowsSyncs({ receipt_id: page.map(r => r.id) }, { take: page.length }) : []
    const byReceipt = new Map(syncs.map(s => [s.receipt_id, s]))
    // No sync row (no zenflows_sync key): standalone, an unmappable fixture buyer
    // or a pre-outbox receipt. Those carry no marker and are never recovered.
    receipts.push(...page.map(r => withSync(r, byReceipt.get(r.id) as any)))
    if (page.length < 100) break
  }
  res.json({ receipts, count: receipts.length })
}
