import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketRequest } from "../../market-guard"
import { INTERFACER_MODULE } from "../../../modules/interfacer"
import type InterfacerService from "../../../modules/interfacer/service"
import { listLiveCatalog } from "../../../modules/interfacer/catalog"
import { liveMode } from "../../../modules/interfacer/zenflows-registry"

export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  res.status(204).end()
}
// Live catalog as matching sees it now: current designs/services plus entries
// excluded after revalidation against Zenflows (with the reason).
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketRequest(req, res)) return
  if (!liveMode()) return res.json({ live: false, designs: [], services: [], excluded: [] })
  const catalog = await listLiveCatalog(req.scope.resolve<InterfacerService>(INTERFACER_MODULE))
  res.json({ live: true, designs: catalog.designs, services: catalog.services,
    excluded: catalog.excluded.map(({ entry: _e, ...rest }) => rest) })
}
