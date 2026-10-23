// Live local Zenflows milestone adapter. Stock: raise -> transfer. Build:
// Process -> produce (provider owns output) -> transfer to the order's buyer.
// Seller/unit still use the explicit demo mapping; real buyers are per-order.
// Unconfigured = local receipt only. This is NOT a durable outbox: an ambiguous
// network/DB failure still needs reconciliation, not an automatic blind replay.
export type ZenflowsConfig = {
  url: string
  provider: string
  receiver?: string // legacy fixture buyer only; real sessions supply per-order
  unit: string
  admin?: string
}

export function zenflowsConfig(): ZenflowsConfig | null {
  const url = process.env.INTERFACER_ZENFLOWS_URL
  if (!url) return null
  const provider = process.env.INTERFACER_ZENFLOWS_PROVIDER
  const unit = process.env.INTERFACER_ZENFLOWS_UNIT
  if (!provider || !unit) throw new Error("zenflows_provider_and_unit_required")
  return { url, provider, unit, receiver: process.env.INTERFACER_ZENFLOWS_RECEIVER,
    admin: process.env.INTERFACER_ZENFLOWS_ADMIN }
}

export type ZenflowsEventInput = {
  action: "transfer" | "produce"
  quantity: number
  has_point_in_time: Date
  note?: string
  resource_name?: string
  resource_tracking_id?: string
  provider?: string
  receiver?: string
}

const RESOURCE_SPECS = `{ resourceSpecifications(first:50){ edges{ node{ id name } } } }`
const CREATE_RESOURCE = `mutation($e: EconomicEventCreateParams!, $r: EconomicResourceCreateParams!) {
  createEconomicEvent(event: $e, newInventoriedResource: $r) {
    economicEvent { id resourceInventoriedAs { id } }
  }
}`
const TRANSFER = `mutation($e: EconomicEventCreateParams!) {
  createEconomicEvent(event: $e) { economicEvent { id } }
}`
const PROCESS = `mutation($p: ProcessCreateParams!) { createProcess(process: $p) { process { id } } }`

async function zenflowsGql(cfg: ZenflowsConfig, query: string, variables: unknown, fetchImpl: typeof fetch): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (cfg.admin) headers["zenflows-admin"] = cfg.admin
  const res = await fetchImpl(cfg.url, { method: "POST", headers, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw new Error("zenflows_http_error: " + res.status)
  const json: any = await res.json()
  if (json.errors?.length || !json.data) throw new Error("zenflows_error: " + JSON.stringify(json.errors ?? json))
  return json.data
}

export async function writeZenflowsEvent(
  input: ZenflowsEventInput,
  cfg: ZenflowsConfig | null = zenflowsConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!cfg) return null
  const provider = input.provider ?? cfg.provider
  const receiver = input.receiver ?? cfg.receiver
  if (!provider || !receiver) throw new Error("zenflows_agents_required")
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error("zenflows_positive_quantity_required")
  const when = input.has_point_in_time.toISOString()
  const quantity = { hasNumericalValue: input.quantity, hasUnit: cfg.unit }
  // Do not cache an id globally: a different URL/seed has a different registry.
  const specs = await zenflowsGql(cfg, RESOURCE_SPECS, {}, fetchImpl)
  const spec = specs.resourceSpecifications.edges.find((e: any) => e.node.name === "Product")?.node.id
  if (!spec) throw new Error("zenflows_product_spec_required")
  const resource = {
    name: input.resource_name ?? `Interfacer marketplace ${input.action}`,
    note: `interfacer-marketplace ${input.action}`,
    ...(input.resource_tracking_id ? { trackingIdentifier: input.resource_tracking_id } : {}),
  }

  let processId: string | undefined
  if (input.action === "produce") {
    const process = await zenflowsGql(cfg, PROCESS, { p: {
      name: input.resource_name ?? "Interfacer build", note: input.note,
      hasBeginning: when, hasEnd: when, finished: true,
    } }, fetchImpl)
    processId = process.createProcess?.process?.id
    if (!processId) throw new Error("zenflows_process_missing")
  }
  const created = await zenflowsGql(cfg, CREATE_RESOURCE, {
    e: { action: input.action === "produce" ? "produce" : "raise",
      provider, receiver: provider, resourceConformsTo: spec, resourceQuantity: quantity,
      hasPointInTime: when, note: input.note, ...(processId ? { outputOf: processId } : {}) },
    r: resource,
  }, fetchImpl)
  const resourceId = created.createEconomicEvent?.economicEvent?.resourceInventoriedAs?.id
  if (!resourceId) throw new Error("zenflows_resource_missing")
  const transferred = await zenflowsGql(cfg, TRANSFER, {
    e: { action: "transfer", provider, receiver, resourceInventoriedAs: resourceId,
      resourceQuantity: quantity, hasPointInTime: when, note: input.note },
  }, fetchImpl)
  const eventId = transferred.createEconomicEvent?.economicEvent?.id
  if (!eventId) throw new Error("zenflows_transfer_missing")
  // Both receipt types link the final handover. The build's produce event is
  // linked via the output resource and Process, not mislabeled as this id.
  return eventId
}
