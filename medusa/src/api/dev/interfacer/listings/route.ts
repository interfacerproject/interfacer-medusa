// LOCAL TESTING ONLY: fixture auth, NOT a real PDP/signed envelope. NEVER DEPLOY.
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { allowLocalRequest } from "../local-guard"
import { INTERFACER_MODULE } from "../../../../modules/interfacer"
import type InterfacerService from "../../../../modules/interfacer/service"
import { fixtureControllerCheck, type Resource } from "../../../../modules/interfacer/fixture-controller-check"
import { projectResource, type Passport } from "../../../../modules/interfacer/project-resource"


export async function OPTIONS(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  res.status(204).end()
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const body = req.body as { resource?: Resource; dpp?: Passport; actingPersonId?: string } | null
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.actingPersonId !== "string" || !body.actingPersonId.trim() ||
      body.actingPersonId.length > 1000) {
    res.status(400).json({ reason: "invalid_body: actingPersonId must be a nonempty string (max 1000)" })
    return
  }
  try {
    // Same entrypoint and controller seam as the CLI. No caller-supplied policy,
    // operation key, product IDs, workflow options, or failure injection.
    const { created, product, binding } = await projectResource(
      req.scope, body.resource as Resource, body.dpp as Passport,
      fixtureControllerCheck(body.actingPersonId)
    )
    res.status(created ? 201 : 200).json({
      created,
      product_id: product.id,
      variant_id: binding.medusa_variant_id,
      status: product.status,
      binding,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : ""
    const code = reason.split(":")[0]
    const statuses: Record<string, number> = {
      invalid_source: 400,
      passport_binding_mismatch: 400,
      authorization_denied: 403,
      authorization_unavailable: 403,
      unsupported_obligations: 403,
      idempotency_conflict: 409,
      reconciliation_required: 409,
    }
    if (!Object.prototype.hasOwnProperty.call(statuses, code)) throw error
    res.status(statuses[code]).json({ reason })
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!allowLocalRequest(req, res)) return
  const integration = req.scope.resolve<InterfacerService>(INTERFACER_MODULE)
  const products = req.scope.resolve<IProductModuleService>(Modules.PRODUCT)
  const listings = []
  // Don't silently truncate at the module service's default page size.
  for (let skip = 0; ; skip += 100) {
    const bindings = await integration.listListingBindings({}, {
      take: 100, skip, order: { id: "ASC" },
    })
    for (const binding of bindings) {
      const product = await products.retrieveProduct(binding.medusa_product_id, { relations: ["variants"] })
      listings.push({ binding, product })
    }
    if (bindings.length < 100) break
  }
  res.json({ listings })
}
