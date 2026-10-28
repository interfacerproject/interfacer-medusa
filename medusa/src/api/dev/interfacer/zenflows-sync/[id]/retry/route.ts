import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowLocalRequest } from "../../../local-guard"
import { INTERFACER_MODULE } from "../../../../../../modules/interfacer"
import type InterfacerService from "../../../../../../modules/interfacer/service"
import { runZenflowsSync, syncView } from "../../../../../../modules/interfacer/zenflows-outbox"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}
// Idempotent: advances the row now (ignoring backoff), still reconciling first.
// It cannot change the payload, the target or any checkpoint by request.
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
    res.status(400).json({ reason: "invalid_body: retry accepts only an empty object" })
    return
  }
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const [row] = await integration.listZenflowsSyncs({ id: req.params.id })
  if (!row) return res.status(404).json({ reason: "zenflows_sync_not_found" })
  try { res.json({ sync: syncView(await runZenflowsSync(integration, row.id)) }) }
  catch (e) { res.status(503).json({ reason: "zenflows_sync_deferred", detail: (e as Error).message }) }
}
