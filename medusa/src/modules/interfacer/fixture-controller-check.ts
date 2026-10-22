// RETIRED in P6a. No plaintext escape hatch, even in development.
// Retained only to fail loudly for old callers; cannot grant authorization.
export type { Resource } from "./signed-envelope"
export function fixtureControllerCheck(_personId: string): never {
  throw new Error("fixture_controller_removed: use a real signed envelope")
}
