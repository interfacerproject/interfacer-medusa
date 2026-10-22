// Pure, deterministic structured capability matching; no DB/framework/network.
import { createHash } from "node:crypto"

export type Dimensions = { x: number; y: number; z: number }
export type Requirements = {
  process: string[]; materials: string[]; max_dimensions_mm: Dimensions
  tolerance_mm: number; quantity: number
}
export type Capabilities = {
  processes: string[]; materials: string[]; build_volume_mm: Dimensions; min_tolerance_mm: number
}
export type DesignData = { id: string; name: string; origin_dpp_id: string | null; requirements: Requirements }
export type ServiceData = {
  id: string; name: string; provider_person_id: string; capabilities: Capabilities
  base_price_eur: number; per_unit_price_eur: number
  location: { country_code: string; city: string }
}

// Reject unknown requirements rather than silently ignoring an unsupported
// manufacturing constraint. Values are case-sensitive controlled identifiers.
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k)) ||
      keys.some(k => !(k in value))) throw new Error("invalid_structured_data: " + label)
  return value as Record<string, unknown>
}
function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000)
    throw new Error("invalid_structured_data: " + label)
  return value
}
function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("invalid_structured_data: " + label)
  return value
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("invalid_structured_data: " + label)
  const result = value.map(v => str(v, label))
  if (new Set(result).size !== result.length) throw new Error("invalid_structured_data: duplicate " + label)
  return result
}
function dimensions(value: unknown, label: string): Dimensions {
  const v = object(value, ["x", "y", "z"], label)
  return { x: positive(v.x, label + ".x"), y: positive(v.y, label + ".y"), z: positive(v.z, label + ".z") }
}
export function priceCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)
    throw new Error("invalid_price_eur")
  return Math.round(value * 100)
}
// Parsers deliberately select model fields (DB timestamps aren't terms).
export function parseDesign(value: Record<string, unknown>): DesignData {
  const r = object(value.requirements,
    ["process", "materials", "max_dimensions_mm", "tolerance_mm", "quantity"], "requirements")
  const quantity = positive(r.quantity, "quantity")
  if (!Number.isSafeInteger(quantity) || quantity > 1_000_000) throw new Error("invalid_structured_data: quantity")
  return {
    id: str(value.id, "design.id"), name: str(value.name, "design.name"),
    origin_dpp_id: value.origin_dpp_id == null ? null : str(value.origin_dpp_id, "origin_dpp_id"),
    requirements: {
      process: strings(r.process, "process"), materials: strings(r.materials, "materials"),
      max_dimensions_mm: dimensions(r.max_dimensions_mm, "max_dimensions_mm"),
      tolerance_mm: positive(r.tolerance_mm, "tolerance_mm"), quantity,
    },
  }
}
export function parseService(value: Record<string, unknown>): ServiceData {
  const c = object(value.capabilities,
    ["processes", "materials", "build_volume_mm", "min_tolerance_mm"], "capabilities")
  const l = object(value.location, ["country_code", "city"], "location")
  priceCents(value.base_price_eur)
  priceCents(value.per_unit_price_eur)
  return {
    id: str(value.id, "service.id"), name: str(value.name, "service.name"),
    provider_person_id: str(value.provider_person_id, "provider_person_id"),
    capabilities: {
      processes: strings(c.processes, "processes"), materials: strings(c.materials, "materials"),
      build_volume_mm: dimensions(c.build_volume_mm, "build_volume_mm"),
      min_tolerance_mm: positive(c.min_tolerance_mm, "min_tolerance_mm"),
    },
    base_price_eur: value.base_price_eur as number, per_unit_price_eur: value.per_unit_price_eur as number,
    location: { country_code: str(l.country_code, "country_code"), city: str(l.city, "city") },
  }
}
export function rejectionReasons(design: DesignData, service: ServiceData): string[] {
  const d = parseDesign(design), s = parseService(service), r = d.requirements, c = s.capabilities
  const reasons: string[] = []
  for (const p of r.process) if (!c.processes.includes(p)) reasons.push("wrong_process: missing " + p)
  for (const m of r.materials) if (!c.materials.includes(m)) reasons.push("missing_material: " + m)
  for (const axis of ["x", "y", "z"] as const) {
    if (r.max_dimensions_mm[axis] > c.build_volume_mm[axis])
      reasons.push("too_big: " + axis + " requires " + r.max_dimensions_mm[axis] + "mm > " + c.build_volume_mm[axis] + "mm")
  }
  if (c.min_tolerance_mm > r.tolerance_mm)
    reasons.push("tolerance: service " + c.min_tolerance_mm + "mm > required " + r.tolerance_mm + "mm")
  return reasons
}
export function fixedPrice(design: DesignData, service: ServiceData) {
  const quantity = parseDesign(design).requirements.quantity
  const s = parseService(service)
  const base_price_cents = priceCents(s.base_price_eur), per_unit_price_cents = priceCents(s.per_unit_price_eur)
  const total_price_cents = base_price_cents + per_unit_price_cents * quantity
  // integer storage and safe bounded demo quotes; no silent rounding/overflow.
  if (!Number.isSafeInteger(total_price_cents) || total_price_cents <= 0 || total_price_cents > 100_000_000)
    throw new Error("invalid_quote_total")
  return { currency_code: "eur" as const, quantity, base_price_cents, per_unit_price_cents,
    total_price_cents, amount_eur: total_price_cents / 100 }
}
function compareId(a: { id: string }, b: { id: string }) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }
export function matchServices(design: DesignData, services: ServiceData[]) {
  const d = parseDesign(design)
  const matches: ServiceData[] = [], rejected: { service: ServiceData; reason: string }[] = []
  for (const input of services) {
    const service = parseService(input), reasons = rejectionReasons(d, service)
    if (reasons.length) rejected.push({ service, reason: reasons.join("; ") })
    else matches.push(service)
  }
  matches.sort((a, b) => fixedPrice(d, a).total_price_cents - fixedPrice(d, b).total_price_cents || compareId(a, b))
  rejected.sort((a, b) => compareId(a.service, b.service))
  return { matches, rejected }
}
export function canonicalTerms(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalTerms).join(",") + "]"
  const obj = value as Record<string, unknown>
  return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonicalTerms(obj[k])).join(",") + "}"
}
export function termsHash(value: unknown): string {
  return createHash("sha256").update(canonicalTerms(value)).digest("hex")
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function formBuildQuote(design: DesignData, service: ServiceData) {
  const d = parseDesign(design), s = parseService(service)
  const reasons = rejectionReasons(d, s)
  if (reasons.length) throw new Error("incompatible_service: " + reasons.join("; "))
  // Clone: freezing a quote must not freeze or retain mutable caller inputs.
  const snapshot = freeze(JSON.parse(JSON.stringify({
    version: "interfacer-fixed-build-v1", design: d, service: s, ...fixedPrice(d, s),
  })) as { version: string; design: DesignData; service: ServiceData } & ReturnType<typeof fixedPrice>)
  return freeze({ design_id: d.id, service_id: s.id, provider_person_id: s.provider_person_id,
    origin_dpp_id: d.origin_dpp_id, currency_code: snapshot.currency_code, quantity: snapshot.quantity,
    total_price_cents: snapshot.total_price_cents, quote_hash: termsHash(snapshot), snapshot })
}
