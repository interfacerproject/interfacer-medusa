import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireLocalCommerce } from "./commerce-context"
import { formBuildQuote, matchServices, parseDesign, parseService, priceCents, termsHash } from "./matching"
import { designs, services } from "./matching-fixtures"
import { catalogEntryToService, listLiveCatalog } from "./catalog"
import { liveMode } from "./zenflows-registry"
import { listedForDesign } from "./build-listing"

const LOCK = "interfacer-build-matching-v1"
async function all<T>(list: (skip: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await list(skip)
    rows.push(...page)
    if (page.length < 100) return rows
  }
}
// Live mode: ONLY registered Zenflows resources (revalidated now). Standalone:
// the synthetic seeds of the historical harness.
export async function listDesigns(integration: InterfacerService) {
  if (liveMode()) return (await listLiveCatalog(integration)).designs
  return (await all(skip => integration.listDesigns({}, { skip, take: 100, order: { id: "ASC" } }))).map(parseDesign)
}
function serviceData(row: Awaited<ReturnType<InterfacerService["listServices"]>>[number]) {
  return parseService({ ...row, base_price_eur: row.base_price_cents / 100,
    per_unit_price_eur: row.per_unit_price_cents / 100 })
}
export async function listServices(integration: InterfacerService) {
  if (liveMode()) return (await listLiveCatalog(integration)).services
  return (await all(skip => integration.listServices({}, { skip, take: 100, order: { id: "ASC" } }))).map(serviceData)
}

// The design to match plus candidate services. Live: only services whose owner
// listed this design, at the listed price; listed services that were excluded
// (resource gone, owner changed) are reported as rejections, never quoted.
async function matchSource(integration: InterfacerService, designId: string) {
  if (liveMode()) {
    const catalog = await listLiveCatalog(integration)
    const design = catalog.designs.find(d => d.id === designId)
    if (!design) {
      const excluded = catalog.excluded.find(e => e.kind === "design" && e.resource_id === designId)
      if (excluded) throw new MedusaError(MedusaError.Types.NOT_ALLOWED, excluded.reason)
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "design_not_found")
    }
    const { candidates, listedIds } = await listedForDesign(integration, designId, catalog.services)
    const excluded = catalog.excluded.filter(e => e.kind === "service" && listedIds.has(e.resource_id))
      .map(e => ({ service: catalogEntryToService(e.entry), reason: e.reason }))
    return { design, services: candidates.map(c => c.service), excluded,
      leadDays: new Map(candidates.map(c => [c.service.id, c.lead_days])) }
  }
  const [row] = await integration.listDesigns({ id: designId })
  if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, "design_not_found")
  return { design: parseDesign(row), services: await listServices(integration), excluded: [],
    leadDays: new Map<string, number>() }
}

export async function seedMatching(container: MedusaContainer) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock(LOCK, async () => {
    for (const input of designs) {
      const design = parseDesign(input)
      const [previous] = await integration.listDesigns({ id: design.id })
      if (previous) {
        if (termsHash(parseDesign(previous)) !== termsHash(design)) throw new Error("matching_seed_conflict: " + design.id)
      } else await integration.createDesigns(design)
    }
    for (const input of services) {
      const service = parseService(input)
      const [previous] = await integration.listServices({ id: service.id })
      if (previous) {
        if (termsHash(serviceData(previous)) !== termsHash(service)) throw new Error("matching_seed_conflict: " + service.id)
      } else {
        const { base_price_eur, per_unit_price_eur, ...data } = service
        await integration.createServices({ ...data, base_price_cents: priceCents(base_price_eur),
          per_unit_price_cents: priceCents(per_unit_price_eur) })
      }
    }
    return { designs: await listDesigns(integration), services: await listServices(integration) }
  })
}

export async function matchDesign(container: MedusaContainer, designId: string) {
  requireLocalCommerce()
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock(LOCK, async () => {
    const { design, services, excluded, leadDays } = await matchSource(integration, designId)
    const result = matchServices(design, services)
    const matches = []
    for (const service of result.matches) {
      const terms = formBuildQuote(design, service)
      const [previous] = await integration.listBuildQuotes({ quote_hash: terms.quote_hash })
      if (previous && Object.entries(terms).some(([key, value]) =>
        termsHash(previous[key as keyof typeof previous]) !== termsHash(value))) {
        throw new Error("quote_integrity_failure")
      }
      const quote = previous ?? await integration.createBuildQuotes(terms)
      matches.push({ service, quote, listing: { lead_days: leadDays.get(service.id) ?? null } })
    }
    return { matches, rejected: [...result.rejected, ...excluded] }
  })
}
