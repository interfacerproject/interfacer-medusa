// Seller console data for the AUTHENTICATED, Zenflows-verified Person only: their
// live listings, catalog entries, the orders placed on them and each order's
// receipt + durable Zenflows sync state. Nothing here signs or writes.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { allowStorefront, buyerScene } from "../../../../storefront/dev"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"
import { withSync } from "../../../../modules/interfacer/zenflows-outbox"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowStorefront(req, res)) return
  res.setHeader("Cache-Control", "no-store")
  const person = (await buyerScene(req)).buyer_person_id
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const listings = await integration.listListingBindings({ seller_agent_id: person }, { take: 500 })
  const catalog = await integration.listCatalogEntries({ owner_agent_id: person }, { take: 500, order: { revision: "ASC" } })
  const quotes = await integration.listBuildQuotes({ provider_person_id: person }, { take: 500 })
  const offers = quotes.length ? await integration.listBuildOffers({ quote_id: quotes.map(q => q.id) }, { take: 500 }) : []
  const sold = new Map<string, Record<string, unknown>>([
    ...listings.map(b => [b.medusa_variant_id, { kind: "stock", listing_id: b.id, resource_id: b.catalog_resource_id }] as const),
    ...offers.map(o => {
      const q = quotes.find(x => x.id === o.quote_id)!
      return [o.medusa_variant_id, { kind: "build", quote_id: q.id, design_id: q.design_id, service_id: q.service_id,
        quantity: q.quantity, total_eur: q.total_price_cents / 100 }] as const
    }),
  ])
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const orders: Record<string, unknown>[] = []
  for (let skip = 0; sold.size; skip += 100) {
    const { data } = await query.graph({ entity: "order", pagination: { skip, take: 100 },
      fields: ["id", "status", "created_at", "items.variant_id", "payment_collections.payments.captured_at"] })
    for (const order of data) {
      const ref = order.items?.length === 1 ? sold.get(order.items[0]?.variant_id ?? "") : undefined
      if (!ref) continue
      const captured = order.payment_collections?.some((c: any) => c?.payments?.some((p: any) => p?.captured_at)) ?? false
      orders.push({ id: order.id, status: order.status, created_at: order.created_at, captured, ...ref })
    }
    if (data.length < 100) break
  }
  const ids = orders.map(o => o.id as string)
  const receipts = ids.length ? await integration.listReaReceipts({ order_id: ids }, { take: ids.length }) : []
  const syncs = ids.length ? await integration.listZenflowsSyncs({ order_id: ids }, { take: ids.length }) : []
  for (const order of orders) {
    const receipt = receipts.find(r => r.order_id === order.id)
    order.receipt = receipt ? withSync(receipt, syncs.find(s => s.order_id === order.id) as any) : null
  }
  res.json({ person, listings, catalog, orders })
}
