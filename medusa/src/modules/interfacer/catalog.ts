// LIVE registered catalog: designs and fabrication services are real Zenflows
// resources, registered by the Person accountable for them with a signed,
// strictly validated, versioned document. Manufacturability is NEVER inferred
// from tags; DPP content is never copied (only a derived reference).
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { INTERFACER_MODULE } from "./index"
import type InterfacerService from "./service"
import { requireCommerceMode } from "./deployment"
import { parseDesign, parseService, termsHash, type DesignData, type ServiceData } from "./matching"
import { verifyZenflowsOperation } from "./zenflows-person"
import { derivedDppReference, liveMode, readInstance, readResource } from "./zenflows-registry"
import type { SignedOperation } from "./signed-envelope"

export const DESIGN_SCHEMA = "interfacer-build-requirements-v1"
export const SERVICE_SCHEMA = "interfacer-fabrication-capabilities-v1"
export type CatalogKind = "design" | "service"
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}
function invalid(reason: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, reason)
}
function exactKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid("invalid_catalog_document")
  return value as Record<string, unknown>
}

// Normalized, versioned document. Design: requirements only. Service:
// capabilities, fixed EUR prices and location. Unknown keys are refused.
export function parseCatalogDocument(kind: CatalogKind, document: unknown): Record<string, unknown> {
  try {
    if (kind === "design") {
      const d = exactKeys(document, ["schema_version", "requirements"])
      if (d.schema_version !== DESIGN_SCHEMA) invalid("invalid_catalog_document: schema_version")
      const parsed = parseDesign({ id: "document", name: "document", origin_dpp_id: null, requirements: d.requirements })
      return { schema_version: DESIGN_SCHEMA, requirements: parsed.requirements }
    }
    const d = exactKeys(document, ["schema_version", "capabilities", "base_price_eur", "per_unit_price_eur", "location"])
    if (d.schema_version !== SERVICE_SCHEMA) invalid("invalid_catalog_document: schema_version")
    const { id: _i, name: _n, provider_person_id: _p, ...service } = parseService({ ...d, id: "document",
      name: "document", provider_person_id: "document" })
    return { schema_version: SERVICE_SCHEMA, ...service }
  } catch (e) {
    if (e instanceof MedusaError) throw e
    invalid("invalid_catalog_document: " + (e as Error).message)
  }
}

type Entry = { zenflows_resource_id: string; resource_name: string; owner_agent_id: string; document: unknown }
export function catalogEntryToDesign(entry: Entry): DesignData {
  const doc = entry.document as { requirements: unknown }
  return parseDesign({ id: entry.zenflows_resource_id, name: entry.resource_name,
    origin_dpp_id: derivedDppReference(entry.zenflows_resource_id), requirements: doc.requirements })
}
export function catalogEntryToService(entry: Entry): ServiceData {
  const { schema_version: _s, ...doc } = entry.document as Record<string, unknown>
  return parseService({ ...doc, id: entry.zenflows_resource_id, name: entry.resource_name,
    provider_person_id: entry.owner_agent_id })
}

// The request body IS the signed params; the signer is the envelope's Person,
// proven against the key Zenflows has registered for them.
export async function registerCatalogEntry(container: MedusaContainer, kind: CatalogKind, body: unknown, auth: unknown) {
  requireCommerceMode()
  if (!liveMode()) refuse("catalog_live_mode_required")
  const envelope = (auth as SignedOperation | undefined)?.envelope
  const person = envelope?.person_id
  const params = body as { resource_id?: unknown; document?: unknown } | undefined
  if (typeof person !== "string" || !params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).sort().join(",") !== "document,resource_id" ||
      typeof params.resource_id !== "string" || !ID.test(params.resource_id)) invalid("invalid_catalog_registration")
  await verifyZenflowsOperation(auth, `catalog.${kind}.register`, params, person)
  const document = parseCatalogDocument(kind, params.document)
  const [instance, resource] = await Promise.all([readInstance(), readResource(params.resource_id)])
  if (!resource) refuse("catalog_resource_missing")
  const spec = kind === "design" ? instance.specs.design : instance.specs.service
  if (resource.spec.id !== spec.id) refuse("catalog_spec_mismatch")
  if (resource.accountableType !== "Person" || resource.accountable !== person) refuse("catalog_owner_required")
  const integration = container.resolve<InterfacerService>(INTERFACER_MODULE)
  return integration.withProjectionLock(`interfacer-catalog:${kind}:${resource.id}`, async () => {
    const [latest] = await integration.listCatalogEntries({ kind, zenflows_resource_id: resource.id },
      { order: { revision: "DESC" }, take: 1 })
    const document_hash = termsHash(document)
    // Idempotent: the same owner re-registering the same document and name.
    if (latest && latest.document_hash === document_hash && latest.owner_agent_id === person &&
        latest.resource_name === resource.name) return { created: false, entry: latest }
    const revision = (latest?.revision ?? 0) + 1
    const entry = await integration.createCatalogEntries({
      kind, zenflows_resource_id: resource.id, revision, entry_key: `${kind}:${resource.id}:${revision}`,
      owner_agent_id: person, resource_name: resource.name, spec_id: spec.id,
      schema_version: String(document.schema_version), document, document_hash,
      registered_by: person, registration_hash: termsHash(envelope),
    } as any)
    return { created: true, entry }
  })
}

export type CatalogExclusion = { kind: CatalogKind; resource_id: string; name: string; reason: string; entry: Entry }
// Latest revision per resource, revalidated against Zenflows NOW: an entry whose
// resource vanished, changed spec or changed accountable agent is excluded.
export async function listLiveCatalog(integration: InterfacerService) {
  const rows: any[] = []
  for (let skip = 0; ; skip += 100) {
    const page = await integration.listCatalogEntries({}, { skip, take: 100, order: { revision: "ASC" } })
    rows.push(...page)
    if (page.length < 100) break
  }
  const latest = new Map<string, any>()
  for (const row of rows) latest.set(`${row.kind}:${row.zenflows_resource_id}`, row)
  const designs: DesignData[] = [], services: ServiceData[] = [], excluded: CatalogExclusion[] = []
  for (const entry of latest.values()) {
    const resource = await readResource(entry.zenflows_resource_id)
    const reason = !resource ? "catalog_resource_missing"
      : resource.spec.id !== entry.spec_id ? "catalog_spec_mismatch"
      // A transfer into a new resource leaves the source accountable to the old
      // owner with zero quantity: both mean the owner no longer holds it.
      : resource.accountable !== entry.owner_agent_id || !(resource.accounting > 0) ? "catalog_owner_changed" : null
    if (reason) excluded.push({ kind: entry.kind, resource_id: entry.zenflows_resource_id, name: entry.resource_name, reason, entry })
    else if (entry.kind === "design") designs.push(catalogEntryToDesign(entry))
    else services.push(catalogEntryToService(entry))
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return { designs: designs.sort(byId), services: services.sort(byId), excluded }
}
