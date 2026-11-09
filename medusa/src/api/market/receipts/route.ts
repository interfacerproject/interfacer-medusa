import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { allowMarketStorefront } from "../../market-guard"
import { buyerScene } from "../../../storefront/dev"
import { INTERFACER_MODULE } from "../../../modules/interfacer"
import type InterfacerService from "../../../modules/interfacer/service"
import { withSync } from "../../../modules/interfacer/zenflows-outbox"

// The signed-in Person's own receipts: what they bought (receiver) and what
// they sold or built (provider), each with its Zenflows sync state. Nobody
// else's orders leave the server.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowMarketStorefront(req, res)) return
  const person = (await buyerScene(req)).buyer_person_id
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const page = { take: 500, order: { created_at: "ASC" as const } }
  const [bought, sold] = await Promise.all([
    integration.listReaReceipts({ receiver_id: person }, page),
    integration.listReaReceipts({ provider_id: person }, page),
  ])
  const mine = [...new Map([...bought, ...sold].map(r => [r.id, r])).values()]
  const syncs = mine.length ? await integration.listZenflowsSyncs({ receipt_id: mine.map(r => r.id) }, { take: mine.length }) : []
  const byReceipt = new Map(syncs.map(s => [s.receipt_id, s]))
  const receipts = mine.map(r => withSync(r, byReceipt.get(r.id) as any))
  res.json({ receipts, count: receipts.length })
}
