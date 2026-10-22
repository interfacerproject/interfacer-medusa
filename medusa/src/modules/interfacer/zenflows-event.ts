// Real Zenflows economic-event adapter (bridge C).
//
// When INTERFACER_ZENFLOWS_URL is set, a delivery/production milestone also
// writes a LIVE ValueFlows EconomicEvent to Zenflows (in addition to the local
// rea-receipt record). When it is unset, this is a no-op and the local
// rea-receipts sink remains the only record — so the marketplace still runs
// stand-alone.
//
// DEMO MAPPING (bridge D, coarse): the marketplace's per-run demo agents and
// resources do not correspond to Zenflows entities, so for the demo every event
// is attributed to a fixed, seeded set of real Zenflows ids (provider, receiver,
// resource, unit) read from env. Per-entity fidelity (real provider/receiver/
// resource per listing) is bridge B, still to come. The WRITE is real; the
// actor/resource identity is a labeled demo stand-in.

const CREATE_EVENT = `mutation($e: EconomicEventCreateParams!) {
  createEconomicEvent(event: $e) { economicEvent { id } }
}`

export type ZenflowsEventInput = {
  action: "transfer" | "produce"
  quantity: number
  has_point_in_time: Date
  note?: string
}

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

// Writes the event and returns the created Zenflows event id, or null when
// Zenflows is not configured. Throws on a configured-but-failed write so the
// caller can surface it (the local receipt is already persisted and idempotent).
export async function writeZenflowsEvent(
  input: ZenflowsEventInput,
  cfg: ZenflowsConfig | null = zenflowsConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!cfg) return null
  const event = {
    action: input.action,
    provider: cfg.provider,
    receiver: cfg.receiver,
    resourceInventoriedAs: cfg.resource,
    resourceQuantity: { hasNumericalValue: input.quantity, hasUnit: cfg.unit },
    hasPointInTime: input.has_point_in_time.toISOString(),
    note: input.note ?? `interfacer-marketplace ${input.action}`,
  }
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (cfg.admin) headers["zenflows-admin"] = cfg.admin
  const res = await fetchImpl(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: CREATE_EVENT, variables: { e: event } }),
  })
  const json: any = await res.json()
  if (json.errors?.length || !json.data?.createEconomicEvent?.economicEvent?.id) {
    throw new Error("zenflows_event_failed: " + JSON.stringify(json.errors ?? json))
  }
  return json.data.createEconomicEvent.economicEvent.id as string
}
