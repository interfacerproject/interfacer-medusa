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
  const [receipts, count] = await integration.listAndCountReaReceipts({}, { order: { created_at: "ASC" } })
  res.json({ receipts, count })
}
