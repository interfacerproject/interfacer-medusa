import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../local-guard"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"

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
    receipts.push(...page)
    if (page.length < 100) break
  }
  res.json({ receipts, count: receipts.length })
}
