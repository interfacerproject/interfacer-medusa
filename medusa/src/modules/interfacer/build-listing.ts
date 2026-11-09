// Build listings: the owner of a registered fabrication service declares which
// registered designs it builds, at its own price and lead time. Live matching
// quotes ONLY listed services, at the listed price, and still rechecks
// compatibility (capabilities can change after listing).
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireLocalCommerce } from "./commerce-context"
import { listLiveCatalog } from "./catalog"
import { fixedPrice, priceCents, rejectionReasons, termsHash, type DesignData, type ServiceData } from "./matching"
import { verifyZenflowsOperation } from "./zenflows-person"
import { liveMode } from "./zenflows-registry"
import type { SignedOperation } from "./signed-envelope"

export const BUILD_LISTING_OP = "catalog.build.list"
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const KEYS = ["active", "base_price_eur", "design_id", "lead_days", "per_unit_price_eur", "service_id"]

export type BuildListingParams = {
  service_id: string; design_id: string; base_price_eur: number; per_unit_price_eur: number
  lead_days: number; active: boolean
}
export type BuildListingRow = {
  id: string; service_resource_id: string; design_resource_id: string; revision: number; active: boolean
  base_price_cents: number; per_unit_price_cents: number; lead_days: number; owner_agent_id: string
}
export type BuildListingQuery = { service?: string; design?: string; provider?: string; include_inactive?: boolean }

function invalid(reason: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, reason)
}
function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}

export function parseBuildListingParams(value: unknown): BuildListingParams {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== KEYS.join(",")) invalid("invalid_build_listing")
  const v = value as Record<string, unknown>
  if (typeof v.service_id !== "string" || !ID.test(v.service_id) ||
      typeof v.design_id !== "string" || !ID.test(v.design_id)) invalid("invalid_build_listing: ids")
  let base: number, unit: number
  try {
    base = priceCents(v.base_price_eur)
    unit = priceCents(v.per_unit_price_eur)
  } catch { invalid("invalid_build_listing: price") }
  if (base + unit <= 0) invalid("invalid_build_listing: price")
  if (!Number.isSafeInteger(v.lead_days) || (v.lead_days as number) < 1 || (v.lead_days as number) > 365)
    invalid("invalid_build_listing: lead_days")
  if (typeof v.active !== "boolean") invalid("invalid_build_listing: active")
  return { service_id: v.service_id, design_id: v.design_id, base_price_eur: v.base_price_eur as number,
    per_unit_price_eur: v.per_unit_price_eur as number, lead_days: v.lead_days as number, active: v.active }
}

export function latestListings<T extends BuildListingRow>(rows: T[]): T[] {
  const latest = new Map<string, T>()
  for (const row of rows) {
    const key = row.service_resource_id + ":" + row.design_resource_id
    const previous = latest.get(key)
    if (!previous || row.revision > previous.revision) latest.set(key, row)
  }
  return [...latest.values()]
}

// Service data at the listed price: the quote snapshot then carries the listed
// terms, so quote integrity re-derives the same total from the snapshot.
export function listedService(service: ServiceData, row: Pick<BuildListingRow, "base_price_cents" | "per_unit_price_cents">) {
  return { ...service, base_price_eur: row.base_price_cents / 100, per_unit_price_eur: row.per_unit_price_cents / 100 }
}

// A listing counts only while its signer still owns the (live) service.
function current(row: BuildListingRow, service: ServiceData | undefined): service is ServiceData {
  return !!service && service.provider_person_id === row.owner_agent_id
}

export function listedCandidates(designId: string, services: ServiceData[], rows: BuildListingRow[]) {
  const byId = new Map(services.map(s => [s.id, s]))
  const candidates: { service: ServiceData; lead_days: number }[] = []
  for (const row of latestListings(rows)) {
    const service = byId.get(row.service_resource_id)
    if (row.design_resource_id !== designId || !row.active || !current(row, service)) continue
    candidates.push({ service: listedService(service, row), lead_days: row.lead_days })
  }
  return candidates
}

export function listingViews(rows: BuildListingRow[], designs: DesignData[], services: ServiceData[],
  q: BuildListingQuery) {
  const designById = new Map(designs.map(d => [d.id, d]))
  const serviceById = new Map(services.map(s => [s.id, s]))
  const views = []
  for (const row of latestListings(rows)) {
    const design = designById.get(row.design_resource_id), service = serviceById.get(row.service_resource_id)
    if (!design || !current(row, service)) continue
    if ((!q.include_inactive && !row.active) || (q.service && row.service_resource_id !== q.service) ||
        (q.design && row.design_resource_id !== q.design) || (q.provider && service.provider_person_id !== q.provider))
      continue
    const listed = listedService(service, row)
    let total_eur: number | null = null
    try { total_eur = fixedPrice(design, listed).amount_eur } catch { total_eur = null }
    views.push({
      id: row.id, service_id: service.id, service_name: service.name, provider_person_id: service.provider_person_id,
      location: service.location, design_id: design.id, design_name: design.name,
      base_price_eur: listed.base_price_eur, per_unit_price_eur: listed.per_unit_price_eur, lead_days: row.lead_days,
      quantity: design.requirements.quantity, total_eur, active: row.active,
      compatible: rejectionReasons(design, listed).length === 0, revision: row.revision,
    })
  }
  return views.sort((a, b) => a.design_id < b.design_id ? -1 : a.design_id > b.design_id ? 1
    : (a.total_eur ?? Infinity) - (b.total_eur ?? Infinity))
}

async function allListings(integration: InterfacerService): Promise<BuildListingRow[]> {
  const rows: BuildListingRow[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await integration.listBuildListings({}, { skip, take: 100, order: { revision: "ASC" } })
    rows.push(...(page as unknown as BuildListingRow[]))
    if (page.length < 100) return rows
  }
}

export async function listBuildListings(integration: InterfacerService, q: BuildListingQuery) {
  if (!liveMode()) return []
  const [rows, catalog] = await Promise.all([allListings(integration), listLiveCatalog(integration)])
  return listingViews(rows, catalog.designs, catalog.services, q)
}

// Live candidates for one design (see build-matching): listed services at the
// listed price with their lead time, plus excluded services that had listed it.
export async function listedForDesign(integration: InterfacerService, designId: string, services: ServiceData[]) {
  const rows = await allListings(integration)
  const listedIds = new Set(latestListings(rows)
    .filter(r => r.design_resource_id === designId && r.active).map(r => r.service_resource_id))
  return { candidates: listedCandidates(designId, services, rows), listedIds }
}

// The request body IS the signed params; the signer must own the registered
// service. Pausing (active:false) is always allowed; listing requires a fit.
export async function registerBuildListing(container: MedusaContainer, body: unknown, auth: unknown) {
  requireLocalCommerce()
  if (!liveMode()) refuse("catalog_live_mode_required")
  const envelope = (auth as SignedOperation | undefined)?.envelope
  const person = envelope?.person_id
  if (typeof person !== "string") invalid("invalid_build_listing")
  const params = parseBuildListingParams(body)
  await verifyZenflowsOperation(auth, BUILD_LISTING_OP, body, person)
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  const catalog = await listLiveCatalog(integration)
  const service = catalog.services.find(s => s.id === params.service_id)
  if (!service) refuse("build_listing_service_not_registered")
  if (service.provider_person_id !== person) refuse("build_listing_owner_required")
  const design = catalog.designs.find(d => d.id === params.design_id)
  if (!design) refuse("build_listing_design_not_registered")
  const terms = { service_id: service.id, design_id: design.id, base_price_cents: priceCents(params.base_price_eur),
    per_unit_price_cents: priceCents(params.per_unit_price_eur), lead_days: params.lead_days, active: params.active }
  if (params.active) {
    const listed = listedService(service, terms)
    const reasons = rejectionReasons(design, listed)
    if (reasons.length) refuse("build_listing_incompatible: " + reasons.join("; "))
    try { fixedPrice(design, listed) } catch { invalid("invalid_build_listing: total") }
  }
  return integration.withProjectionLock(`interfacer-build-listing:${service.id}:${design.id}`, async () => {
    const [latest] = await integration.listBuildListings(
      { service_resource_id: service.id, design_resource_id: design.id }, { order: { revision: "DESC" }, take: 1 })
    const terms_hash = termsHash(terms)
    // Idempotent: the same owner re-signing the same terms.
    if (latest && latest.terms_hash === terms_hash && latest.owner_agent_id === person)
      return { created: false, listing: latest }
    const revision = (latest?.revision ?? 0) + 1
    const listing = await integration.createBuildListings({
      service_resource_id: service.id, design_resource_id: design.id, revision,
      entry_key: `${service.id}:${design.id}:${revision}`, owner_agent_id: person, active: terms.active,
      base_price_cents: terms.base_price_cents, per_unit_price_cents: terms.per_unit_price_cents,
      lead_days: terms.lead_days, terms_hash, registered_by: person, registration_hash: termsHash(envelope),
    })
    return { created: true, listing }
  })
}
