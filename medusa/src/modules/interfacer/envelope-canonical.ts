// P6a canonical JSON: UTF-8, recursively UTF-16-key-sorted objects, JSON number
// and string encoding, array order preserved; no whitespace or trailing newline.
// Shared by the Node CLI and verifier. Only JSON data is accepted.
export function canonicalOperation(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalOperation).join(",") + "]"
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>
    return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonicalOperation(obj[k])).join(",") + "}"
  }
  throw new Error("invalid_canonical_operation")
}
