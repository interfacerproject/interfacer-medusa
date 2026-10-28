import assert from "node:assert/strict"
import { test } from "node:test"
import { catalogEntryToDesign, catalogEntryToService, DESIGN_SCHEMA, parseCatalogDocument, SERVICE_SCHEMA } from "../modules/interfacer/catalog"
import { formBuildQuote, matchServices } from "../modules/interfacer/matching"

const requirements = { process: ["fdm_3d_print"], materials: ["PETG"], max_dimensions_mm: { x: 120, y: 80, z: 60 },
  tolerance_mm: 0.3, quantity: 2 }
const capabilities = { processes: ["fdm_3d_print"], materials: ["PETG", "PLA"], build_volume_mm: { x: 220, y: 220, z: 250 },
  min_tolerance_mm: 0.2 }
const service = { schema_version: SERVICE_SCHEMA, capabilities, base_price_eur: 10, per_unit_price_eur: 4.5,
  location: { country_code: "it", city: "Torino" } }
const design = { schema_version: DESIGN_SCHEMA, requirements }

test("documents are versioned and strict: unknown keys, wrong versions and bad values are refused", () => {
  assert.deepEqual(parseCatalogDocument("design", design), design)
  assert.deepEqual(parseCatalogDocument("service", service), service)
  for (const [kind, doc] of [
    ["design", { ...design, schema_version: "interfacer-build-requirements-v2" }],
    ["design", { ...design, tags: ["3d"] }],
    ["design", { requirements }],
    ["design", { ...design, requirements: { ...requirements, quantity: 0 } }],
    ["service", { ...service, schema_version: DESIGN_SCHEMA }],
    ["service", { ...service, provider_person_id: "someone-else" }],
    ["service", { ...service, base_price_eur: 1.234 }],
    ["service", { ...service, capabilities: { ...capabilities, materials: [] } }],
    ["service", null], ["design", []],
  ] as const) assert.throws(() => parseCatalogDocument(kind, doc), /invalid_catalog_document/, JSON.stringify(doc))
})

test("entries map to matching data keyed by the Zenflows resource; provider is the registered owner; DPP is derived", () => {
  const d = catalogEntryToDesign({ zenflows_resource_id: "06GDESIGN0000000000000000A", resource_name: "Lamp shade",
    owner_agent_id: "06GDESIGNER000000000000000", document: design })
  assert.equal(d.id, "06GDESIGN0000000000000000A")
  assert.equal(d.origin_dpp_id, "zenflows:traceDpp:06GDESIGN0000000000000000A")
  const s = catalogEntryToService({ zenflows_resource_id: "06GSERVICE000000000000000A", resource_name: "Torino FDM",
    owner_agent_id: "06GMAKER0000000000000000AA", document: service })
  assert.equal(s.provider_person_id, "06GMAKER0000000000000000AA")
  assert.equal(s.id, "06GSERVICE000000000000000A")
  const { matches } = matchServices(d, [s])
  assert.equal(matches.length, 1)
  const quote = formBuildQuote(d, s)
  assert.equal(quote.provider_person_id, "06GMAKER0000000000000000AA")
  assert.equal(quote.total_price_cents, 1900)
  assert.equal(quote.origin_dpp_id, d.origin_dpp_id)
})
