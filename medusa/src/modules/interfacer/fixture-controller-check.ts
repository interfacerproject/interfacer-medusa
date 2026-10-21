// LOCAL TEST SEAM. This is NOT Zenroom signing or registered-key verification.
// Only the guarded local /dev route and CLI expose this seam. Production needs online PDP
// verification of a bound envelope and freshly loaded authoritative resource.
export interface Resource {
  id: string
  name: string
  primaryAccountable: { id: string }
}
export interface ControllerDecision {
  subject: string
  allow: boolean
  obligations: unknown[]
  policyVersion: string
  permissionEpoch: string
}
export type ControllerCheck = (resource: Resource) => Promise<ControllerDecision>

export function fixtureControllerCheck(personId: string): ControllerCheck {
  return async (resource) => {
    if (process.env.INTERFACER_AUTH_MODE !== "fixture-controller-stub" ||
        process.env.NODE_ENV === "production") {
      throw new Error("authorization_unavailable: fixture seam is disabled")
    }
    return {
      subject: personId,
      allow: personId === resource.primaryAccountable.id,
      obligations: [],
      policyVersion: "fixture-controller-stub-v1",
      permissionEpoch: "fixture-0",
    }
  }
}
