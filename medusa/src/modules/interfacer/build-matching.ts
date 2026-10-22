import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireLocalCommerce } from "./commerce-context"
import { formBuildQuote, matchServices, parseDesign, parseService, priceCents, termsHash } from "./matching"
import { designs, services } from "./matching-fixtures"

const LOCK = "interfacer-build-matching-v1"
async function all<T>(list: (skip: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await list(skip)
    rows.push(...page)
    if (page.length < 100) return rows
  }
}
export async function listDesigns(integration: InterfacerService) {
  return (await all(skip => integration.listDesigns({}, { skip, take: 100, order: { id: "ASC" } }))).map(parseDesign)
}
function serviceData(row: Awaited<ReturnType<InterfacerService["listServices"]>>[number]) {
  return parseService({ ...row, base_price_eur: row.base_price_cents / 100,
    per_unit_price_eur: row.per_unit_price_cents / 100 })
}
export async function listServices(integration: InterfacerService) {
  return (await all(skip => integration.listServices({}, { skip, take: 100, order: { id: "ASC" } }))).map(serviceData)
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
    const [row] = await integration.listDesigns({ id: designId })
    if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, "design_not_found")
    const design = parseDesign(row)
    const result = matchServices(design, await listServices(integration))
    const matches = []
    for (const service of result.matches) {
      const terms = formBuildQuote(design, service)
      const [previous] = await integration.listBuildQuotes({ quote_hash: terms.quote_hash })
      if (previous && Object.entries(terms).some(([key, value]) =>
        termsHash(previous[key as keyof typeof previous]) !== termsHash(value))) {
        throw new Error("quote_integrity_failure")
      }
      const quote = previous ?? await integration.createBuildQuotes(terms)
      matches.push({ service, quote })
    }
    return { matches, rejected: result.rejected }
  })
}
