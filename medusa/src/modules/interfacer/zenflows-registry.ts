// Read-only Zenflows registry adapter for LIVE mode: instance specs/unit and the
// facts of one resource. Marketplace writes never trust a request-supplied
// resource document; they re-read it here. Missing = null, outage = throw.
import { zenflowsConfig, zenflowsTransport, type ZenflowsConfig } from "./zenflows-event"
import { ZenflowsRejected } from "./zenflows-sync"

export function liveMode(): boolean {
  return Boolean(process.env.INTERFACER_ZENFLOWS_URL)
}

export type Spec = { id: string; name: string }
export type ZenflowsInstance = { specs: { design: Spec; service: Spec; product: Spec }; unitOne: string }
export type ZenflowsResource = {
  id: string; name: string; spec: Spec
  accountable: string; accountableType: string; custodian: string
  onhand: number; accounting: number; unit: string
}

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const INSTANCE = `{ instanceVariables { specs { specProjectDesign { id name } specProjectService { id name }
  specProjectProduct { id name } } units { unitOne { id } } } }`
const RESOURCE = `query($id: ID!) { economicResource(id: $id) { id name conformsTo { id name }
  primaryAccountable { id __typename } custodian { id }
  onhandQuantity { hasNumericalValue hasUnit { id } } accountingQuantity { hasNumericalValue hasUnit { id } } } }`

export function requireZenflows(cfg: ZenflowsConfig | null = zenflowsConfig()): ZenflowsConfig {
  if (!cfg) throw new Error("zenflows_registry_not_configured")
  return cfg
}

export async function readInstance(cfg: ZenflowsConfig = requireZenflows(), fetchImpl: typeof fetch = fetch): Promise<ZenflowsInstance> {
  const v = (await zenflowsTransport(cfg, fetchImpl)(INSTANCE, {}))?.instanceVariables
  const spec = (s: any): Spec => {
    if (typeof s?.id !== "string" || typeof s?.name !== "string") throw new Error("zenflows_instance_incomplete")
    return { id: s.id, name: s.name }
  }
  const unitOne = v?.units?.unitOne?.id
  if (typeof unitOne !== "string") throw new Error("zenflows_instance_incomplete")
  return { specs: { design: spec(v.specs?.specProjectDesign), service: spec(v.specs?.specProjectService),
    product: spec(v.specs?.specProjectProduct) }, unitOne }
}

export async function readResource(id: string, cfg: ZenflowsConfig = requireZenflows(),
  fetchImpl: typeof fetch = fetch): Promise<ZenflowsResource | null> {
  if (!ID.test(id)) throw new Error("invalid_zenflows_resource")
  let r: any
  try { r = (await zenflowsTransport(cfg, fetchImpl)(RESOURCE, { id }))?.economicResource }
  catch (e) {
    if (e instanceof ZenflowsRejected && /not found/.test(e.message)) return null
    throw e
  }
  if (!r) return null
  const num = (q: any) => Number(q?.hasNumericalValue)
  if (r.id !== id || typeof r.name !== "string" || typeof r.conformsTo?.id !== "string" ||
      typeof r.primaryAccountable?.id !== "string" || typeof r.custodian?.id !== "string" ||
      !Number.isFinite(num(r.onhandQuantity)) || !Number.isFinite(num(r.accountingQuantity)) ||
      typeof r.accountingQuantity?.hasUnit?.id !== "string") throw new Error("zenflows_resource_malformed")
  return { id, name: r.name, spec: { id: r.conformsTo.id, name: r.conformsTo.name },
    accountable: r.primaryAccountable.id, accountableType: String(r.primaryAccountable.__typename),
    custodian: r.custodian.id, onhand: num(r.onhandQuantity), accounting: num(r.accountingQuantity),
    unit: r.accountingQuantity.hasUnit.id }
}

// Derived reference to Zenflows' own traceDpp of a resource: never asserted by
// an owner, never copied. Consumers resolve it in Zenflows.
export function derivedDppReference(resourceId: string): string {
  return "zenflows:traceDpp:" + resourceId
}
