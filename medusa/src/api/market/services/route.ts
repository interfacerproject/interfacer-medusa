import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { INTERFACER_MODULE } from "../../../modules/interfacer"
import type InterfacerService from "../../../modules/interfacer/service"
import { listServices } from "../../../modules/interfacer/build-matching"
import { allowMarketRequest } from "../../market-guard"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.json({ services: await listServices(req.scope.resolve<InterfacerService>(INTERFACER_MODULE)) })
}
export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
