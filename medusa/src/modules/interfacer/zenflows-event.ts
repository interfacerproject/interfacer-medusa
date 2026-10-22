// Real Zenflows economic-event adapter (bridges B / C / D).
//
// When INTERFACER_ZENFLOWS_URL is set, a delivery/production milestone writes
// LIVE ValueFlows events to Zenflows (in addition to the local rea-receipt):
//  - stock delivery: RAISE a real per-listing EconomicResource (owned by the
//    provider agent), then TRANSFER it to the buyer — so resourceInventoriedAs
//    is a real, per-listing resource (bridge B) between real agents (bridge D).
//  - build production: PRODUCE a real built resource for the buyer.
// When the var is unset this is a no-op and the local rea-receipts sink remains
// the only record, so the marketplace still runs stand-alone.
//
// Still a labeled demo mapping: the provider agent, the buyer person and the
// unit are seeded Zenflows ids read from env (one seller org, one buyer person
// in the demo). The RESOURCE is now created per listing/build; the WRITE and the
// agents are real.

export type ZenflowsConfig = {
  url: string
  provider: string
  receiver: string
  resource: string
  unit: string
  admin?: string
}

export function zenflowsConfig(): ZenflowsConfig | null {
  const url = process.env.INTERFACER_ZENFLOWS_URL
  const provider = process.env.INTERFACER_ZENFLOWS_PROVIDER
  const receiver = process.env.INTERFACER_ZENFLOWS_RECEIVER
  const resource = process.env.INTERFACER_ZENFLOWS_RESOURCE
  const unit = process.env.INTERFACER_ZENFLOWS_UNIT
  if (!url || !provider || !receiver || !resource || !unit) return null
  return { url, provider, receiver, resource, unit, admin: process.env.INTERFACER_ZENFLOWS_ADMIN }
}

export type ZenflowsEventInput = {
  action: "transfer" | "produce"
  quantity: number
  has_point_in_time: Date
  note?: string
  // Bridge B: name + tracking id for the real per-listing/build resource.
  resource_name?: string
  resource_tracking_id?: string
  // Bridge D: resolved real agents for this specific order (fall back to config).
  provider?: string
  receiver?: string
}

const RESOURCE_SPECS = `{ resourceSpecifications(first:50){ edges{ node{ id name } } } }`
const RAISE = `mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) {
  createEconomicEvent(event: $e, newInventoriedResource: $r) {
    economicEvent { id resourceInventoriedAs { id } }
  }
}`
const TRANSFER = `mutation($e: EconomicEventCreateParams!) {
  createEconomicEvent(event: $e) { economicEvent { id } }
}`

async function zenflowsGql<T = any>(cfg: ZenflowsConfig, query: string, variables: any, fetchImpl: typeof fetch): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (cfg.admin) headers["zenflows-admin"] = cfg.admin
  const res = await fetchImpl(cfg.url, { method: "POST", headers, body: JSON.stringify({ query, variables }) })
  const json: any = await res.json()
  if (json.errors?.length || !json.data) throw new Error("zenflows_error: " + JSON.stringify(json.errors ?? json))
  return json.data as T
}

let productSpecId: string | null = null
async function productSpec(cfg: ZenflowsConfig, fetchImpl: typeof fetch): Promise<string> {
  if (productSpecId) return productSpecId
  const data = await zenflowsGql<{ resourceSpecifications: { edges: { node: { id: string; name: string } }[] } }>(
    cfg, RESOURCE_SPECS, {}, fetchImpl,
  )
  const edges = data.resourceSpecifications.edges
  const pick = edges.find(e => e.node.name === "Product") ?? edges.find(e => e.node.name === "Material") ?? edges[0]
  if (!pick) throw new Error("zenflows_error: no resource specification to conform to")
  productSpecId = pick.node.id
  return productSpecId
}

// Writes the milestone to Zenflows and returns the created economic-event id, or
// null when Zenflows is not configured. Throws on a configured-but-failed write
// so the caller can keep the local receipt and surface the failure.
export async function writeZenflowsEvent(
  input: ZenflowsEventInput,
  cfg: ZenflowsConfig | null = zenflowsConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!cfg) return null
  const provider = input.provider ?? cfg.provider
  const receiver = input.receiver ?? cfg.receiver
  const when = input.has_point_in_time.toISOString()
  const quantity = { hasNumericalValue: input.quantity, hasUnit: cfg.unit }
  const spec = await productSpec(cfg, fetchImpl)
  const newResource = {
    name: input.resource_name ?? `Interfacer marketplace ${input.action}`,
    note: `interfacer-marketplace ${input.action}`,
    ...(input.resource_tracking_id ? { trackingIdentifier: input.resource_tracking_id } : {}),
  }

  // Both milestones: RAISE the real per-listing/build resource (owned by the
  // provider), then TRANSFER that exact resource to the buyer. This is the
  // valid VF path without introducing a Process; a true `produce` output of a
  // Process is a later refinement. The returned id is the transfer event.
  const raised = await zenflowsGql(cfg, RAISE, {
    e: { action: "raise", provider, receiver: provider, resourceConformsTo: spec, resourceQuantity: quantity, hasPointInTime: when, note: `${input.action} stock for ${input.note ?? input.action}` },
    r: newResource,
  }, fetchImpl)
  const resourceId = raised.createEconomicEvent.economicEvent.resourceInventoriedAs.id as string
  const data = await zenflowsGql(cfg, TRANSFER, {
    e: { action: "transfer", provider, receiver, resourceInventoriedAs: resourceId, resourceQuantity: quantity, hasPointInTime: when, note: input.note },
  }, fetchImpl)
  return data.createEconomicEvent.economicEvent.id as string
}
