import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../local-guard"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"
import { syncView } from "../../../../modules/interfacer/zenflows-outbox"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const syncs = []
  for (let skip = 0; ; skip += 100) {
    const page = await integration.listZenflowsSyncs({}, { skip, take: 100, order: { created_at: "ASC" } })
    // The marker is what an operator searches for in Zenflows notes when reconciling.
    syncs.push(...page.map(s => ({ order_id: s.order_id, receipt_id: s.receipt_id, marker: s.marker, ...syncView(s as any) })))
    if (page.length < 100) break
  }
  res.json({ syncs, count: syncs.length })
}
