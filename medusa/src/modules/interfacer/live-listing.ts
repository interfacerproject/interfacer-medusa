// LIVE stock listing of a seller's REAL Zenflows Product resource. The seller
// signs only {resource_id}; every listed fact is re-read from Zenflows. The
// sale later transfers one unit of this very resource (no stand-in raise).
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { requireCommerceMode } from "./deployment"
import { projectVerifiedResource } from "./project-resource"
import { verifyZenflowsOperation } from "./zenflows-person"
import { derivedDppReference, liveMode, readInstance, readResource } from "./zenflows-registry"
import type { SignedOperation } from "./signed-envelope"

export const LIVE_POLICY = "zenflows-registry-v1"
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

function refuse(reason: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, reason)
}

// The request body IS the signed params ({resource_id}); the signer is the seller.
export async function createLiveListing(container: MedusaContainer, body: unknown, auth: unknown) {
  requireCommerceMode()
  if (!liveMode()) refuse("listing_live_mode_required")
  const envelope = (auth as SignedOperation | undefined)?.envelope
  const person = envelope?.person_id
  const params = body as { resource_id?: unknown } | undefined
  if (typeof person !== "string" || !params || typeof params !== "object" || Array.isArray(params) ||
      Object.keys(params).join(",") !== "resource_id" || typeof params.resource_id !== "string" ||
      !ID.test(params.resource_id)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "invalid_live_listing")
  await verifyZenflowsOperation(auth, "commerce.listing.live.create", params, person)
  const [instance, resource] = await Promise.all([readInstance(), readResource(params.resource_id)])
  if (!resource) refuse("listing_resource_unavailable")
  if (resource.spec.id !== instance.specs.product.id) refuse("catalog_spec_mismatch")
  // Zenflows' transfer requires the provider to be both accountable and custodian.
  if (resource.accountableType !== "Person" || resource.accountable !== person || resource.custodian !== person)
    refuse("catalog_owner_required")
  if (!(resource.onhand >= 1) || !(resource.accounting >= 1)) refuse("listing_resource_unavailable")
  return projectVerifiedResource(container,
    { id: resource.id, name: resource.name, primaryAccountable: { id: person } },
    { ID: derivedDppReference(resource.id), ProductID: resource.id },
    person, { policy_version: LIVE_POLICY, permission_epoch: LIVE_POLICY, zenflows_unit_id: resource.unit })
}
