import assert from "node:assert/strict"
import { test } from "node:test"
import { latestListings, listedCandidates, listingViews, parseBuildListingParams,
  type BuildListingRow } from "../modules/interfacer/build-listing"
import { formBuildQuote, matchServices, type DesignData, type ServiceData } from "../modules/interfacer/matching"

// Crockford base32 (no I, L, O, U), 26 chars, like Zenflows ids.
const DESIGN = "06GDESGN0000000000000000AA"
const OTHER_DESIGN = "06GDESGN0000000000000000AB"
const SERVICE = "06GSERVCE0000000000000000A"
const MAKER = "06GMAKER0000000000000000AA"

const design: DesignData = { id: DESIGN, name: "Lamp shade", origin_dpp_id: "zenflows:traceDpp:" + DESIGN,
  requirements: { process: ["fdm_3d_print"], materials: ["PETG"], max_dimensions_mm: { x: 120, y: 80, z: 60 },
    tolerance_mm: 0.3, quantity: 2 } }
const service: ServiceData = { id: SERVICE, name: "Torino FDM", provider_person_id: MAKER,
  capabilities: { processes: ["fdm_3d_print"], materials: ["PETG", "PLA"], build_volume_mm: { x: 220, y: 220, z: 250 },
    min_tolerance_mm: 0.2 }, base_price_eur: 10, per_unit_price_eur: 4.5,
  location: { country_code: "it", city: "Torino" } }

const params = { service_id: SERVICE, design_id: DESIGN, base_price_eur: 8, per_unit_price_eur: 3.25,
  lead_days: 4, active: true }

function row(over: Partial<BuildListingRow> = {}): BuildListingRow {
  return { id: "ifbl_1", service_resource_id: SERVICE, design_resource_id: DESIGN, revision: 1, active: true,
    base_price_cents: 800, per_unit_price_cents: 325, lead_days: 4, owner_agent_id: MAKER, ...over }
}

test("params are exact: ULID ids, two-decimal prices, whole lead days in 1..365, boolean active", () => {
  assert.deepEqual(parseBuildListingParams(params), params)
  for (const bad of [
    { ...params, extra: 1 },
    { ...params, service_id: "not-an-id" },
    { ...params, design_id: 42 },
    { ...params, base_price_eur: 1.234 },
    { ...params, per_unit_price_eur: -1 },
    { ...params, base_price_eur: 0, per_unit_price_eur: 0 },
    { ...params, lead_days: 0 },
    { ...params, lead_days: 366 },
    { ...params, lead_days: 2.5 },
    { ...params, active: "yes" },
    (({ active: _a, ...rest }) => rest)(params),
    null, [],
  ]) assert.throws(() => parseBuildListingParams(bad), /invalid_build_listing/, JSON.stringify(bad))
})

test("the latest revision per (service, design) wins", () => {
  const rows = [row({ revision: 1 }), row({ revision: 3, active: false }), row({ revision: 2, lead_days: 9 }),
    row({ design_resource_id: OTHER_DESIGN, revision: 1 })]
  const latest = latestListings(rows)
  assert.equal(latest.length, 2)
  assert.equal(latest.find(r => r.design_resource_id === DESIGN)!.revision, 3)
})

test("only actively listed services are candidates, quoted at the LISTED price with their lead time", () => {
  const unlisted: ServiceData = { ...service, id: "06GSERVCE0000000000000000B" }
  const candidates = listedCandidates(DESIGN, [service, unlisted], [row()])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].lead_days, 4)
  assert.equal(candidates[0].service.base_price_eur, 8)
  assert.equal(candidates[0].service.per_unit_price_eur, 3.25)
  // The quote snapshot carries the listed terms, so integrity re-derives them.
  const quote = formBuildQuote(design, candidates[0].service)
  assert.equal(quote.total_price_cents, 800 + 325 * 2)
  assert.deepEqual(formBuildQuote(quote.snapshot.design, quote.snapshot.service).quote_hash, quote.quote_hash)
  assert.equal(listedCandidates(DESIGN, [service], [row({ revision: 2, active: false }), row()]).length, 0)
  assert.equal(listedCandidates(OTHER_DESIGN, [service], [row()]).length, 0)
})

test("a listing signed by someone who no longer owns the service is ignored", () => {
  const transferred: ServiceData = { ...service, provider_person_id: "06GNEWOWNER000000000000000" }
  assert.equal(listedCandidates(DESIGN, [transferred], [row()]).length, 0)
})

test("listed but incompatible is rejected at match time, never quoted", () => {
  const shrunk: ServiceData = { ...service, capabilities: { ...service.capabilities, materials: ["PLA"] } }
  const candidates = listedCandidates(DESIGN, [shrunk], [row()])
  const { matches, rejected } = matchServices(design, candidates.map(c => c.service))
  assert.equal(matches.length, 0)
  assert.match(rejected[0].reason, /missing_material: PETG/)
})

test("views join live designs and services, drop excluded ones, and filter", () => {
  const rows = [row(), row({ id: "ifbl_2", design_resource_id: OTHER_DESIGN, active: false })]
  const views = listingViews(rows, [design], [service], {})
  assert.equal(views.length, 1)
  assert.deepEqual(
    (({ id, service_name, design_name, base_price_eur, per_unit_price_eur, lead_days, quantity, total_eur, compatible }) =>
      ({ id, service_name, design_name, base_price_eur, per_unit_price_eur, lead_days, quantity, total_eur, compatible }))(views[0]),
    { id: "ifbl_1", service_name: "Torino FDM", design_name: "Lamp shade", base_price_eur: 8, per_unit_price_eur: 3.25,
      lead_days: 4, quantity: 2, total_eur: 14.5, compatible: true })
  assert.equal(listingViews(rows, [], [service], {}).length, 0, "design gone from the live catalog")
  assert.equal(listingViews(rows, [design], [], {}).length, 0, "service gone from the live catalog")
  assert.equal(listingViews(rows, [design], [service], { provider: "06GSOMEONE0000000000000000" }).length, 0)
  assert.equal(listingViews(rows, [design], [service], { include_inactive: true, service: SERVICE }).length, 1,
    "the paused listing's design is not in the live catalog")
})
